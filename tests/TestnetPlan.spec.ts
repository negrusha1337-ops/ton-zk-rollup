import { execFileSync } from 'child_process';
import path from 'path';
import { beginCell, toNano } from '@ton/core';
import { loadRethBatchReport, loadRethExpected, RETH_PROVEN_BLOCKS, RethExpected, RethQueueItem } from '../wrappers/evmProofs';
import { BASE_DEPOSIT_FEE } from '../wrappers/Rollup';
import { MIN_ESCAPE_TIMEOUT_SECONDS, MIN_MAX_BLOCK_AGE_SECONDS } from '../wrappers/rollupDeployment';
import { LATE_DEPOSIT_VALUE, TESTNET_ESCAPE_TIMEOUT_SECONDS, TESTNET_MAX_BLOCK_AGE_SECONDS } from '../wrappers/rollupValues';
import {
    BASE_FORCE_TRANSACTION_FEE,
    estimateWalletFees,
    exitGaps,
    forwardFeeOf,
    payoutArrived,
    preflightRefusals,
    queueFeeDoublings,
    queuePlan,
    QUEUE_FEE_STEP,
    recipientProblems,
    timeConfigProblems,
    timeDecision,
    TimeInput,
    walletNeed,
} from '../wrappers/testnetPlan';

// Расчёты прогона полного цикла v2 в testnet (wrappers/testnetPlan.ts) на нынешней цепочке
// (fixtures/evm_batches/reth/expected.json): очередь и плата за место, потребность кошелька,
// окно времени батчей, отказы предполётной проверки. Сети и контракта здесь нет.
const expected = loadRethExpected();
const LAST = RETH_PROVEN_BLOCKS[RETH_PROVEN_BLOCKS.length - 1];
const dataChunks = RETH_PROVEN_BLOCKS.map((block) => loadRethBatchReport(block).dataChunksHex.length);
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
const need = (walletFees = 0n) => walletNeed(expected, { lastBatch: LAST, keyParts: 12, dataChunks, walletFees });

describe('План прогона testnet: очередь L1 и плата за место', () => {
    it('очередь ставится по порядку номеров, перед батчем k — до headAtBatch блока k', () => {
        const plan = queuePlan(expected, LAST);
        expect(plan.map(({ item }) => item.number)).toEqual(Array.from({ length: expected.blocks[LAST - 1].headAtBatch }, (_, index) => index + 1));
        for (const batch of RETH_PROVEN_BLOCKS) {
            const upTo = expected.blocks[batch - 1].headAtBatch;
            const from = batch === 1 ? 0 : expected.blocks[batch - 2].headAtBatch;
            expect(plan.filter(({ beforeBatch }) => beforeBatch === batch).map(({ item }) => item.number)).toEqual(
                Array.from({ length: upTo - from }, (_, index) => from + index + 1),
            );
        }
        // В нынешней цепочке перед батчем 1 в очереди два элемента, а обрабатывает он один.
        expect(plan.filter(({ beforeBatch }) => beforeBatch === 1)).toHaveLength(expected.blocks[0].headAtBatch);
        expect(expected.blocks[0].headAtBatch).toBeGreaterThan(expected.blocks[0].queueProcessedUpTo);
    });

    it('к депозиту прикладывается сумма и плата, к принудительной транзакции — только плата', () => {
        const plan = queuePlan(expected, LAST);
        for (const { item, fee, value } of plan) {
            if (item.kind === 'deposit') {
                expect(fee).toBe(BASE_DEPOSIT_FEE);
                expect(value).toBe(BigInt(item.amount) + BASE_DEPOSIT_FEE);
            } else {
                expect(fee).toBe(BASE_FORCE_TRANSACTION_FEE);
                expect(value).toBe(BASE_FORCE_TRANSACTION_FEE);
            }
        }
        // Необработанный хвост нынешней цепочки короче шага удвоения: плата везде базовая.
        expect(plan.some(({ item }) => item.kind === 'forced')).toBe(true);
    });

    it('плата удваивается на каждые 64 необработанных элемента и сбрасывается принятым батчем', () => {
        expect([0, 63, 64, 127, 128].map((pending) => queueFeeDoublings(pending))).toEqual([0, 0, 1, 1, 2]);
        expect(queueFeeDoublings(64 * 100)).toBe(40);
        // Цепочка из двух батчей: перед первым в очереди 130 депозитов, обрабатывает он 100;
        // перед вторым добавляется ещё 40 принудительных.
        const deposit = (number: number, batch: number): RethQueueItem => ({ number, batch, kind: 'deposit', l2Recipient: '0x01', amount: '50000000' });
        const forced = (number: number, batch: number): RethQueueItem => ({ number, batch, kind: 'forced', label: 'x', bytes: '0x00', outcome: 'x' });
        const queue = [
            ...Array.from({ length: 130 }, (_, index) => deposit(index + 1, index < 100 ? 1 : 2)),
            ...Array.from({ length: 40 }, (_, index) => forced(131 + index, 2)),
        ];
        const block = (number: number, from: number, upTo: number, headAtBatch: number) =>
            ({ number, queueProcessedFrom: from, queueProcessedUpTo: upTo, headAtBatch }) as RethExpected['blocks'][number];
        const plan = queuePlan({ queue, blocks: [block(1, 0, 100, 130), block(2, 100, 170, 170)] }, 2);
        const feeOf = (number: number) => plan[number - 1].fee;
        expect(feeOf(1)).toBe(BASE_DEPOSIT_FEE);
        expect(feeOf(QUEUE_FEE_STEP)).toBe(BASE_DEPOSIT_FEE);
        expect(feeOf(QUEUE_FEE_STEP + 1)).toBe(2n * BASE_DEPOSIT_FEE);
        expect(feeOf(2 * QUEUE_FEE_STEP + 1)).toBe(4n * BASE_DEPOSIT_FEE);
        expect(feeOf(130)).toBe(4n * BASE_DEPOSIT_FEE);
        // После батча 1 в хвосте 30 элементов: плата снова базовая, а с 64-го необработанного — двойная.
        expect(feeOf(131)).toBe(BASE_FORCE_TRANSACTION_FEE);
        expect(feeOf(100 + QUEUE_FEE_STEP)).toBe(BASE_FORCE_TRANSACTION_FEE);
        expect(feeOf(100 + QUEUE_FEE_STEP + 1)).toBe(2n * BASE_FORCE_TRANSACTION_FEE);
        expect(plan[129].value).toBe(50_000_000n + 4n * BASE_DEPOSIT_FEE);
    });

    it('цепочка с номерами не подряд либо с полем batch не по отметкам блоков отвергается', () => {
        const shifted = { ...expected, queue: expected.queue.map((item, index) => (index === 3 ? { ...item, number: 99 } : item)) };
        expect(() => queuePlan(shifted, LAST)).toThrow(/имеет номер 99/);
        const relabelled = { ...expected, queue: expected.queue.map((item, index) => (index === 0 ? { ...item, batch: 2 } : item)) };
        expect(() => queuePlan(relabelled, LAST)).toThrow(/помечен батчем 2/);
        expect(() => queuePlan(expected, expected.blocks.length + 1)).toThrow(/в цепочке нет/);
    });
});

describe('План прогона testnet: потребность кошелька', () => {
    it('разбивка сходится с очередью, листьями моста и выходами нынешней цепочки', () => {
        const plan = queuePlan(expected, LAST);
        const result = need();
        const line = (start: string) => result.lines.find(({ what }) => what.startsWith(start))!;
        const deposits = plan.filter(({ item }) => item.kind === 'deposit');
        const forced = plan.filter(({ item }) => item.kind === 'forced');
        const leaves = expected.withdrawals.filter((leaf) => leaf.block <= LAST);
        const exits = expected.exitsByBlock.find(({ block }) => block === LAST)!.exits;
        const deposited = sum(deposits.map(({ item }) => BigInt((item as { amount: string }).amount)));
        const back = sum(leaves.map((leaf) => BigInt(leaf.amount))) + sum(exits.map((exit) => BigInt(exit.balanceWei) / 1_000_000_000n));
        expect(line('депозиты: суммы')).toMatchObject({ spent: deposited, returns: back, messages: deposits.length });
        expect(line('депозиты: плата')).toMatchObject({ spent: BigInt(deposits.length) * BASE_DEPOSIT_FEE, returns: 0n });
        expect(line('принудительные')).toMatchObject({ spent: BigInt(forced.length) * BASE_FORCE_TRANSACTION_FEE, messages: forced.length });
        expect(line('выводы через мост').messages).toBe(leaves.length);
        expect(leaves.length).toBe(5);
        expect(line('аварийные выходы').messages).toBe(2);
        expect(line('поздний депозит')).toMatchObject({ spent: LATE_DEPOSIT_VALUE, returns: LATE_DEPOSIT_VALUE - BASE_DEPOSIT_FEE });
        // Итоги — суммы строк; сообщений — развёртывание и ключ, очередь, данные, батчи, выводы,
        // поздний депозит, заморозка, выходы и возврат.
        expect(result.total).toBe(sum(result.lines.map(({ spent }) => spent)));
        expect(result.returns).toBe(back + LATE_DEPOSIT_VALUE - BASE_DEPOSIT_FEE);
        expect(result.lost).toBe(result.total - result.returns);
        expect(result.messages).toBe(14 + plan.length + dataChunks.reduce((a, b) => a + b, 0) + LAST + leaves.length + 3 + exits.length);
        // Вернуться может не больше внесённого: остальное осталось на L2 (контракты, комиссии, переводы).
        expect(back).toBeLessThanOrEqual(deposited);
        expect(back).toBeGreaterThan(0n);
    });

    it('комиссии кошелька входят в потребность и не возвращаются', () => {
        const [bare, withFees] = [need(), need(toNano('0.5'))];
        expect(withFees.total - bare.total).toBe(toNano('0.5'));
        expect(withFees.returns).toBe(bare.returns);
    });

    it('плата за пересылку растёт с битами и ячейками тела, одинаковые ячейки считаются один раз', () => {
        const prices = { lumpPriceNano: 1000, bitPriceNanoPerBit: 10, cellPriceNanoPerCell: 100 };
        const leaf = beginCell().storeUint(1, 8).endCell();
        expect(forwardFeeOf(leaf, prices)).toBe(1000n + 80n + 100n);
        const twice = beginCell().storeRef(leaf).storeRef(leaf).endCell();
        expect(forwardFeeOf(twice, prices)).toBe(1000n + 80n + 200n);
        const fees = estimateWalletFees([leaf], 0, prices);
        expect(estimateWalletFees([leaf, twice], 3, prices)).toBeGreaterThan(fees);
        expect(estimateWalletFees([], 1, prices)).toBeGreaterThan(estimateWalletFees([], 0, prices));
    });

    it('цепочка, выплачивающая больше внесённого, отвергается; число порций данных — по батчам', () => {
        const generous = { ...expected, withdrawals: expected.withdrawals.map((leaf) => ({ ...leaf, amount: '9000000000' })) };
        expect(() => walletNeed(generous, { lastBatch: LAST, keyParts: 12, dataChunks, walletFees: 0n })).toThrow(/больше, чем внесено/);
        expect(() => walletNeed(expected, { lastBatch: LAST, keyParts: 12, dataChunks: [1], walletFees: 0n })).toThrow(/не для каждого батча/);
    });
});

describe('План прогона testnet: получатель и согласия на выход', () => {
    it('цепочка годится только кошельку, под который собрана', () => {
        expect(recipientProblems(expected, expected.exitRecipientHash, LAST)).toEqual([]);
        expect(recipientProblems(expected, expected.exitRecipientHash.replace(/^0x/, '').toUpperCase(), LAST)).toEqual([]);
        const stranger = '0x' + '11'.repeat(32);
        const problems = recipientProblems(expected, stranger, LAST);
        expect(problems).toHaveLength(2);
        expect(problems[0]).toMatch(/согласия на аварийный выход/);
        expect(problems[1]).toMatch(/листья 0, 1, 2, 3, 4/);
        // Чужой лист моста среди своих — тоже отказ.
        const mixed = { ...expected, withdrawals: expected.withdrawals.map((leaf) => (leaf.leafIndex === 2 ? { ...leaf, recipientHash: stranger } : leaf)) };
        expect(recipientProblems(mixed, expected.exitRecipientHash, LAST)).toEqual([expect.stringMatching(/листья 2\)/)]);
    });

    it('16-2: блок без согласий на выход назван вместе с суммой, которая там застрянет', () => {
        const gaps = exitGaps(expected, LAST);
        const consented = new Set(expected.exitsByBlock.map(({ block }) => block));
        expect(gaps.map(({ block }) => block)).toEqual([1, 2].filter((block) => !consented.has(block)));
        // Без согласий вовсе: после батча 1 застрял бы первый депозит, после батча 2 — оба.
        const none = exitGaps({ ...expected, exitsByBlock: [] }, LAST);
        const deposits = expected.queue.filter((item) => item.kind === 'deposit').map((item) => BigInt((item as { amount: string }).amount));
        expect(none).toEqual([
            { block: 1, lockedNano: deposits[0] },
            { block: 2, lockedNano: deposits[0] + deposits[1] },
        ]);
    });
});

describe('План прогона testnet: окно времени батчей', () => {
    const timestamps = RETH_PROVEN_BLOCKS.map((block) => expected.blocks[block - 1].timestamp);
    const [first, last] = [timestamps[0], timestamps[timestamps.length - 1]];
    const input = (now: number, overrides: Partial<TimeInput> = {}): TimeInput => ({
        blockTimestamps: timestamps,
        maxBlockAge: TESTNET_MAX_BLOCK_AGE_SECONDS,
        escapeTimeout: TESTNET_ESCAPE_TIMEOUT_SECONDS,
        now,
        messagesLeft: 45,
        oldestPendingAt: 0,
        secondsPerMessage: 20,
        marginSeconds: 60,
        maxWaitSeconds: 600,
        ...overrides,
    });

    it('параметры стенда допустимы для контракта, недопустимые названы', () => {
        expect(timeConfigProblems(TESTNET_MAX_BLOCK_AGE_SECONDS, TESTNET_ESCAPE_TIMEOUT_SECONDS)).toEqual([]);
        expect(timeConfigProblems(MIN_MAX_BLOCK_AGE_SECONDS - 1, MIN_ESCAPE_TIMEOUT_SECONDS)).toEqual([expect.stringMatching(/возраст блока/)]);
        expect(timeConfigProblems(MIN_MAX_BLOCK_AGE_SECONDS, MIN_ESCAPE_TIMEOUT_SECONDS - 1)).toEqual([expect.stringMatching(/срок заморозки/)]);
        expect(timeConfigProblems(7200, 3600)).toEqual([expect.stringMatching(/больше срока заморозки/)]);
    });

    it('окно — от времени последнего блока до времени первого плюс maxBlockAge', () => {
        const decision = timeDecision(input(last + 60));
        expect(decision).toMatchObject({ opensAt: last, closesAt: first + TESTNET_MAX_BLOCK_AGE_SECONDS, pathSeconds: 900, startAt: last + 60 });
        expect(decision.latestStartAt).toBe(first + TESTNET_MAX_BLOCK_AGE_SECONDS - 60 - 900);
        expect(decision.action).toBe('go');
        // Блоки нынешней цепочки идут через секунду: окно почти равно maxBlockAge.
        expect(decision.closesAt - decision.opensAt).toBe(TESTNET_MAX_BLOCK_AGE_SECONDS - (last - first));
    });

    it('границы: до окна — ждать либо отказ, в окне — идти, после последнего срока начала — отказ', () => {
        const { startAt, latestStartAt, closesAt } = timeDecision(input(last));
        expect(timeDecision(input(startAt - 1))).toMatchObject({ action: 'wait', waitSeconds: 1 });
        expect(timeDecision(input(startAt - 600))).toMatchObject({ action: 'wait', waitSeconds: 600 });
        const early = timeDecision(input(startAt - 601));
        expect(early.action).toBe('refuse');
        expect(early.reason).toMatch(/больше, чем задано ждать/);
        expect(timeDecision(input(startAt)).action).toBe('go');
        expect(timeDecision(input(latestStartAt)).action).toBe('go');
        const late = timeDecision(input(latestStartAt + 1));
        expect(late.action).toBe('refuse');
        expect(late.reason).toMatch(/до закрытия \d+ с, а на путь/);
        const closed = timeDecision(input(closesAt + 5));
        expect(closed.action).toBe('refuse');
        expect(closed.reason).toMatch(/окно закрыто 5 с назад/);
    });

    it('чем меньше осталось сообщений, тем позже можно начать', () => {
        const full = timeDecision(input(last));
        const resumed = timeDecision(input(last, { messagesLeft: 3 }));
        expect(resumed.latestStartAt - full.latestStartAt).toBe(42 * 20);
        expect(timeDecision(input(full.latestStartAt + 1, { messagesLeft: 3 })).action).toBe('go');
    });

    it('путь длиннее окна либо срока заморозки — отказ при любом времени запуска', () => {
        const slow = timeDecision(input(last + 60, { secondsPerMessage: 60 }));
        expect(slow.action).toBe('refuse');
        expect(slow.reason).toMatch(/в окно не помещается/);
        // Окно шире срока заморозки не бывает (maxBlockAge ≤ escapeTimeout), но элемент мог встать
        // в очередь раньше: тогда срок идёт от него.
        const stale = timeDecision(input(last + 60, { oldestPendingAt: last + 60 - 3000 }));
        expect(stale.action).toBe('refuse');
        expect(stale.reason).toMatch(/дольше срока заморозки/);
        expect(timeDecision(input(last + 60, { oldestPendingAt: last + 60 - 2000 })).action).toBe('go');
    });
});

describe('План прогона testnet: предполётная проверка и сверка выплаты', () => {
    const go = timeDecision({
        blockTimestamps: [1000, 1001, 1002], maxBlockAge: 1800, escapeTimeout: 3600, now: 1100,
        messagesLeft: 45, oldestPendingAt: 0, secondsPerMessage: 20, marginSeconds: 60, maxWaitSeconds: 0,
    });
    const ready = () => ({
        proofs: { current: true, reason: '' },
        timeConfig: [] as string[],
        recipient: [] as string[],
        need: need(),
        balance: need().total,
        time: go,
    });

    it('всё сошлось — отказов нет; баланс ровно в потребность годится', () => {
        expect(go.action).toBe('go');
        expect(preflightRefusals(ready())).toEqual([]);
    });

    it('отказ при недостатке баланса называет, сколько не хватает', () => {
        const refusals = preflightRefusals({ ...ready(), balance: need().total - 1n });
        expect(refusals).toEqual([expect.stringMatching(/не хватает 0\.0000 TON/)]);
        const poor = preflightRefusals({ ...ready(), balance: need().total - toNano('2.25') });
        expect(poor).toEqual([expect.stringMatching(/не хватает 2\.2500 TON/)]);
    });

    it('отказ при чужом получателе, негодных пруфах, недопустимых параметрах и закрытом окне — каждый назван', () => {
        const stranger = recipientProblems(expected, '0x' + '22'.repeat(32), LAST);
        expect(preflightRefusals({ ...ready(), recipient: stranger })).toEqual([
            expect.stringMatching(/^получатель: согласия/),
            expect.stringMatching(/^получатель: выводы через мост/),
        ]);
        expect(preflightRefusals({ ...ready(), proofs: { current: false, reason: 'sp1_evm_reth2: пруфа нет' } })).toEqual([
            'пруфы блоков не годятся: sp1_evm_reth2: пруфа нет',
        ]);
        expect(preflightRefusals({ ...ready(), timeConfig: timeConfigProblems(100, 3600) })).toEqual([expect.stringMatching(/^параметры стенда: возраст блока/)]);
        const closed = { ...go, action: 'refuse' as const, reason: 'окно закрыто' };
        expect(preflightRefusals({ ...ready(), time: closed })).toEqual(['время: окно закрыто']);
        // Ожидание окна — не отказ.
        expect(preflightRefusals({ ...ready(), time: { ...go, action: 'wait', waitSeconds: 10 } })).toEqual([]);
    });

    it('выплата сверяется по балансу кошелька с допуском на комиссии и плату за хранение', () => {
        const check = { before: toNano('2'), sent: toNano('0.02'), amount: toNano('0.05'), tolerance: toNano('0.01') };
        // Дошла: баланс вырос на сумму за вычетом приложенного и комиссий в пределах допуска.
        expect(payoutArrived({ ...check, after: toNano('2') - toNano('0.02') - toNano('0.006') + toNano('0.05') - 89n })).toBe(true);
        expect(payoutArrived({ ...check, after: check.before - check.sent + check.amount - check.tolerance })).toBe(true);
        // Не дошла: с кошелька ушли только приложенное и комиссии.
        expect(payoutArrived({ ...check, after: toNano('2') - toNano('0.02') - toNano('0.006') })).toBe(false);
        expect(payoutArrived({ ...check, after: check.before - check.sent + check.amount - check.tolerance - 1n })).toBe(false);
        // Допуск не меньше суммы — сверка бессмысленна.
        expect(() => payoutArrived({ ...check, after: 0n, tolerance: check.amount })).toThrow(/допуск не меньше суммы/);
    });
});

describe('План прогона testnet: расчёт профилей сценария (zkvm-evm/scenario/profile.mjs)', () => {
    // Сценарий цепочки — модуль ESM и считает потребность кошелька своим кодом и своей копией цен.
    // Здесь тот же состав очереди пересчитывается кодом прогона: расхождение цен либо формулы
    // между двумя местами роняет тест.
    type ProfilePlan = {
        problems: string[];
        queue: { batch: number; kind: 'deposit' | 'forced'; amount?: string }[];
        withdrawals: string[];
        need: Record<string, string | number>;
    };
    const planOf = (profile: string): ProfilePlan =>
        JSON.parse(execFileSync('node', [path.join(__dirname, '..', 'zkvm-evm', 'scenario', 'profile.mjs'), profile], { encoding: 'utf8' }));

    it.each(['default', 'testnet'])('профиль %s: потребность по коду прогона равна расчёту сценария', (name) => {
        const plan = planOf(name);
        expect(plan.problems).toEqual([]);
        const queue: RethQueueItem[] = plan.queue.map((item, index) =>
            item.kind === 'deposit'
                ? { number: index + 1, batch: item.batch, kind: 'deposit', l2Recipient: '0x01', amount: item.amount! }
                : { number: index + 1, batch: item.batch, kind: 'forced', label: 'x', bytes: '0x00', outcome: 'x' },
        );
        const upTo = (batch: number) => queue.filter((item) => item.batch <= batch).length;
        const block = (number: number, headAtBatch: number) =>
            ({ number, queueProcessedFrom: number === 1 ? 0 : upTo(number - 1), queueProcessedUpTo: upTo(number), headAtBatch }) as RethExpected['blocks'][number];
        const exited = BigInt(plan.need.exitedAtLeast);
        const exit = (nano: bigint) => ({ account: '0x01', balanceWei: (nano * 1_000_000_000n).toString(), nonce: 0, accountProof: [], signature: '0x' });
        const source = {
            // Перед батчем 1 в очереди оба депозита — как в сценарии.
            blocks: [block(1, 2), block(2, upTo(2)), block(3, upTo(3))],
            queue,
            withdrawals: plan.withdrawals.map((amount, leafIndex) => ({ leafIndex, recipientHash: '0x01', amount, block: 3 })),
            exitRecipientHash: '0x01',
            exitsByBlock: [{ block: 3, blockHash: '0x', consentHash: '0x', exits: [exit(exited - 1n), exit(1n)] }],
        };
        const mine = walletNeed(source, { lastBatch: 3, keyParts: 12, dataChunks: [1, 1, 1], walletFees: BigInt(plan.need.walletFees) });
        expect(mine.total).toBe(BigInt(plan.need.total));
        expect(mine.returns).toBe(BigInt(plan.need.returns));
        expect(mine.lost).toBe(BigInt(plan.need.lost));
        expect(mine.messages).toBe(plan.need.messages);
    });

    it('профиль default — нынешняя цепочка: та же очередь батчей 1–3, те же платы', () => {
        const plan = planOf('default');
        const current = queuePlan(expected, LAST);
        expect(plan.queue.map(({ batch, kind }) => ({ batch, kind }))).toEqual(current.map(({ item }) => ({ batch: item.batch, kind: item.kind })));
        expect(BigInt(plan.need.forcedFees) + BigInt(plan.need.depositFees)).toBe(sum(current.map(({ fee }) => fee)));
        // Профиль testnet: принудительных — десять негодных подписей и три случая; платы втрое меньше.
        const cheap = planOf('testnet');
        expect(cheap.queue.filter(({ kind }) => kind === 'forced')).toHaveLength(13);
        expect(BigInt(cheap.need.total)).toBeLessThan(BigInt(plan.need.total) / 2n);
    });
});
