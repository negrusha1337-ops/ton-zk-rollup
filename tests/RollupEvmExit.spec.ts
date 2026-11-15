import { Blockchain, BlockchainSnapshot, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { readFileSync } from 'fs';
import path from 'path';
import { keccak_256 } from '@noble/hashes/sha3';
import { Bn254Groth16Verifier } from '../wrappers/Bn254Groth16Verifier';
import {
    EVM_MAX_CELLS,
    evmBytesCell,
    evmHeaderCell,
    evmNodeAtoms,
    evmNodeCell,
    evmNodeItems,
    evmProofCell,
    evmProofSteps,
    evmSignatureCell,
    evmSignatureFromHex,
    evmSnake,
    EvmProofStep,
} from '../wrappers/evmExit';
import { loadEvmRollupKey } from '../wrappers/evmProofs';
import { exitNullifierKey, NullifierErrors, Rollup, RollupErrors } from '../wrappers/Rollup';
import {
    DEPLOY_VALUE,
    ESCAPE_SERVICE_VALUE,
    KEY_FINALIZE_VALUE,
    KEY_PART_VALUE,
    LATE_DEPOSIT_VALUE,
} from '../wrappers/rollupValues';
import { saveGasReport } from './helpers/benchResults';
import { computePhaseOf } from './helpers/gas';
import { plantStateRoot, ProtocolConstants, readProtocolConstants, testConfig } from './helpers/rollupSetup';

// Аварийный выход счёта EVM без пруфа zkVM (contracts/rollup/evm_exit.tolk) на настоящем
// контракте: он сам проверяет заголовок блока, доказательство счёта и подпись владельца.
//
// Слово состояния контракта в этих тестах — хеш заголовка из фикстуры. Настоящий контракт
// меняет его только батчем с верным пруфом, а начинает работу только с генезиса протокола,
// поэтому контракт развёртывается канонически (генезис, настоящий ключ, FinalizeKey), а слово
// состояния затем подменяется прямо в хранилище песочницы (plantStateRoot). Сам выход от того,
// как слово состояния туда попало, не зависит. Ключ — из fixtures/evm_batches (он построен под
// прежний протокол, но выходу ключ не нужен вовсе: важно лишь, что он настоящего размера).
//
// Основная фикстура — fixtures/evm_exit/exit.json: настоящие заголовок блока, eth_getProof и
// подпись от узла anvil (zk/gen-evm-exit-fixture.mjs). Там же собранные случаи: формы дерева,
// которых в маленькой цепочке не встретить, и узлы с верным хешем, но неверной формой — по
// случаю на каждую проверку разбора. Каждую защиту снимает zk/evm-exit-mutation-check.py и
// смотрит, что упал именно её тест.

/** Коды отказа проверки счёта EVM: enum EvmExitErrors в contracts/rollup/evm_exit.tolk. */
const EvmExitErrors = {
    badEncoding: 7400,
    wrongBlockHeader: 7401,
    badRlp: 7402,
    wrongNodeHash: 7403,
    keyNotInTrie: 7404,
    badNode: 7405,
    badSignature: 7406,
};

type SyntheticCase = {
    name: string;
    expect: string;
    balanceWei: string;
    hints?: boolean[];
    underfunded?: boolean;
    gas?: string;
    blockHash: string;
    headerRlp: string;
    proof: string[];
    signature: string;
};

const fixture = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'evm_exit', 'exit.json'), 'utf8'));
const bytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex');
const big = (hex: string) => BigInt(hex);
const keccak = (...parts: Buffer[]) => Buffer.from(keccak_256(Buffer.concat(parts)));
const TIMEOUT = 3600;
const START = 1_800_000_000;
const TX_GAS_LIMIT = 1_000_000;
/** 1 нанотон = 1 gwei — единица протокола; её подмену в контракте ловит мутация «баланс не делится». */
const WEI_PER_NANOTON = 1_000_000_000n;
describe('Rollup: аварийный выход счёта EVM без пруфа', () => {
    const chainId = BigInt(fixture.chainId);
    const key = loadEvmRollupKey();
    const recipient = new Address(0, bytes(fixture.recipientHash));
    const header = bytes(fixture.headerRlp);
    const nodes: Buffer[] = fixture.accountProof.map(bytes);
    const account = big(fixture.account);
    const amount = BigInt(fixture.balanceWei) / WEI_PER_NANOTON;
    const gas: Record<string, number> = {};

    let code: Cell;
    let nullifierCode: Cell;
    let constants: ProtocolConstants;
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let rollup: SandboxContract<Rollup>;
    let frozen: BlockchainSnapshot;
    let budget: { stepGas: number; minValue: bigint };
    let exitValue: bigint;
    let base: {
        blockchain: Blockchain;
        owner: SandboxContract<TreasuryContract>;
        user: SandboxContract<TreasuryContract>;
        rollup: SandboxContract<Rollup>;
    };

    /** Разворачивает настоящий контракт с ключом программы EVM и ставит ему слово состояния `blockHash`. */
    const deploy = async (blockHash: Buffer) => {
        blockchain = await Blockchain.create();
        blockchain.now = START;
        owner = await blockchain.treasury('owner');
        user = await blockchain.treasury('user');
        rollup = blockchain.openContract(
            Rollup.createFromConfig(
                testConfig(constants, {
                    owner: owner.address,
                    sequencer: owner.address,
                    nullifierCode,
                    chainId,
                    escapeTimeout: TIMEOUT,
                }),
                code,
            ),
        );
        await rollup.sendDeploy(owner.getSender(), DEPLOY_VALUE);
        for (const { slot, part } of Bn254Groth16Verifier.keyParts(key.upload)) {
            await rollup.sendUploadKeyPart(owner.getSender(), { slot, part, value: KEY_PART_VALUE });
        }
        await rollup.sendFinalizeKey(owner.getSender(), { key: key.upload, value: KEY_FINALIZE_VALUE });
        expect(await rollup.getKeyHash()).toBe(key.keyHash);
        await plantStateRoot(blockchain, rollup.address, BigInt('0x' + blockHash.toString('hex')));
    };
    /**
     * Депозит, который никто не обработал, и заморозка после срока. Депозит же даёт контракту
     * монеты на выплату: в тесте за балансом счёта L2 нет настоящего обеспечения.
     */
    const freeze = async (deposit = toNano('5')) => {
        await rollup.sendDeposit(user.getSender(), { l2Recipient: 0x1234n, value: deposit });
        blockchain.now = START + TIMEOUT + 1;
        const result = await rollup.sendActivateEscapeHatch(user.getSender(), toNano('0.05'));
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        expect((await rollup.getEscapeState()).frozen).toBe(true);
    };
    const exit = (
        opts: {
            to?: Address;
            headerCell?: Cell;
            steps?: EvmProofStep[];
            signature?: string;
            value?: bigint;
        } = {},
    ) =>
        rollup.sendForceExitEvm(user.getSender(), {
            recipient: opts.to ?? recipient,
            header: opts.headerCell ?? evmHeaderCell(header),
            proof: evmProofCell(opts.steps ?? evmProofSteps(nodes)),
            signature: evmSignatureCell(evmSignatureFromHex(opts.signature ?? fixture.signature)),
            value: opts.value ?? exitValue,
        });
    const rejected = (result: { transactions: unknown }, exitCode: number) =>
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: false, exitCode });
    const paid = (result: { transactions: unknown }, to: Address, value: bigint) =>
        expect(result.transactions).toHaveTransaction({ from: rollup.address, to, value });
    const balanceOf = async (address: Address) => (await blockchain.getContract(address)).balance;
    /** Узел с одним изменённым байтом. */
    const corrupted = (node: Buffer, at: number) => {
        const copy = Buffer.from(node);
        copy[at] ^= 1;
        return copy;
    };
    /** Шаги доказательства, где узел `index` заменён ячейкой `node` (вид узла прежний). */
    const stepsWith = (index: number, node: Cell) =>
        evmProofSteps(nodes).map((step, i) => (i === index ? { ...step, node } : step));
    /** Та же ячейка с добавленными битами и ссылками. */
    const extended = (cell: Cell, extraBits: number, extraRefs: number) => {
        const slice = cell.beginParse();
        const builder = beginCell().storeBits(slice.loadBits(slice.remainingBits));
        while (slice.remainingRefs > 0) builder.storeRef(slice.loadRef());
        for (let i = 0; i < extraBits; i++) builder.storeBit(0);
        for (let i = 0; i < extraRefs; i++) builder.storeRef(beginCell().endCell());
        return builder.endCell();
    };
    /**
     * Чем кончится разбор настоящей ветки, выданной за узел с путём: её первый элемент контракт
     * прочтёт как путь. Пустой элемент путём быть не может; у хеша первый байт — «признаки».
     */
    const branchAsPathOutcome = (node: Buffer) => {
        const first = evmNodeItems(node)[0];
        if (first.length === 1) return EvmExitErrors.badRlp;
        const flags = first[1] >> 4;
        if (flags > 3 || ((flags & 1) === 0 && (first[1] & 15) !== 0)) return EvmExitErrors.badNode;
        return EvmExitErrors.keyNotInTrie;
    };

    beforeAll(async () => {
        code = await compile('Rollup');
        nullifierCode = await compile('RollupNullifier');
        constants = await readProtocolConstants(code, nullifierCode);
        await deploy(bytes(fixture.blockHash));
        budget = await rollup.getEvmExitBudget();
        exitValue = (budget.minValue * 11n) / 10n;
        await freeze();
        frozen = blockchain.snapshot();
        base = { blockchain, owner, user, rollup };
    });

    beforeEach(async () => {
        // Тесты с собранными деревьями разворачивают свои контракты: возвращаемся к основному.
        ({ blockchain, owner, user, rollup } = base);
        await blockchain.loadFrom(frozen);
    });

    afterAll(() => {
        // Скрипт мутаций гоняет набор на испорченном контракте: его замеры в bench не попадают
        // (и сам saveGasReport не пишет, пока исходник подменён).
        if (process.env.EVM_EXIT_NO_BENCH) return;
        saveGasReport(
            'rollup-evm-exit.json',
            {
                source: 'Измерено в @ton/sandbox тестом tests/RollupEvmExit.spec.ts; не редактировать вручную',
                note: 'Газ аварийного выхода счёта EVM без пруфа zkVM: контракт сам проверяет заголовок блока, доказательство счёта и подпись. forceExitEvm — настоящее доказательство от anvil (число узлов — proofNodes); forceExitEvmDeep — собранное дерево из десяти полных веток и листа, глубже любого настоящего. stepGasBudget — запас газа шага, из которого контракт считает минимум монет.',
                gasLimit: TX_GAS_LIMIT,
                stepGasBudget: budget.stepGas,
                proofNodes: nodes.length,
                proofNodeBytes: nodes.map((node) => node.length),
                headerBytes: header.length,
            },
            gas,
            ['forceExitEvm', 'forceExitEvmDeep'],
        );
        console.table(gas);
    });

    it('фикстура — настоящий блок: хеш заголовка и согласие сходятся и вне контракта, и в нём', async () => {
        expect(keccak(header).toString('hex')).toBe(fixture.blockHash.slice(2));
        expect((await rollup.getRollupState()).stateRoot).toBe(big(fixture.blockHash));
        // Хеш согласия контракт считает сам; подпись под ним проверена при создании фикстуры.
        expect(await rollup.getEvmExitConsentHash(big(fixture.recipientHash))).toBe(big(fixture.consentHash));
        expect(nodes.length).toBeGreaterThanOrEqual(3);
    });

    it('счёт выходит по заголовку, доказательству и подписи: выплата получателю, один раз', async () => {
        const before = await balanceOf(recipient);
        const result = await exit();
        expect(result.transactions).toHaveTransaction({ to: rollup.address, success: true });
        gas.forceExitEvm = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(gas.forceExitEvm).toBeLessThanOrEqual(budget.stepGas);
        // 1,5 монеты и хвост меньше 1 gwei: выплачивается ровно 1,5 TON, хвост теряется.
        expect(amount).toBe(1_500_000_000n);
        paid(result, recipient, amount);
        expect((await balanceOf(recipient)) - before).toBe(amount);
        const nullifier = await rollup.getExitNullifierAddress(account);
        expect((await blockchain.getContract(nullifier)).accountState?.type).toBe('active');

        // Повторный выход того же счёта: нуллификатор отказывает, второй выплаты нет.
        const again = await exit();
        expect(again.transactions).toHaveTransaction({
            to: nullifier,
            success: false,
            exitCode: NullifierErrors.alreadyClaimed,
        });
        expect(again.transactions).not.toHaveTransaction({ from: rollup.address, to: recipient });
        expect((await balanceOf(recipient)) - before).toBe(amount);
    });

    it('ровно минимума монет хватает на выход с выплатой', async () => {
        paid(await exit({ value: budget.minValue }), recipient, amount);
    });

    it('подпись с номером восстановления 0 или 1 вместо 27 или 28 тоже годится', async () => {
        const v = bytes(fixture.signature)[64];
        expect([27, 28]).toContain(v);
        const signature = fixture.signature.slice(0, -2) + (v - 27).toString(16).padStart(2, '0');
        paid(await exit({ signature }), recipient, amount);
    });

    it('экзотическая ячейка в заголовке или в узле отвергается: байты обязаны лежать в сообщении', async () => {
        // «Змейку» читает общий код (contracts/rollup/bytes.tolk), тот же, что у принудительных
        // транзакций: ячейки читаются через XCTOS. Ссылку на библиотеку обычное чтение молча
        // заменило бы её содержимым — библиотека зарегистрирована, и без проверки выход ПРОШЁЛ бы.
        const libraryReferenceTo = (content: Cell) => {
            const libraries = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
            libraries.set(BigInt('0x' + content.hash().toString('hex')), content);
            blockchain.libs = beginCell().storeDictDirect(libraries).endCell();
            return beginCell().storeUint(2, 8).storeBuffer(content.hash()).endCell({ exotic: true });
        };
        rejected(await exit({ headerCell: libraryReferenceTo(evmHeaderCell(header)) }), EvmExitErrors.badEncoding);
        const last = nodes.length - 1;
        rejected(
            await exit({ steps: stepsWith(last, libraryReferenceTo(evmNodeCell(nodes[last]))) }),
            EvmExitErrors.badEncoding,
        );
        blockchain.libs = undefined;
        // Те же ячейки обычными — выход проходит.
        paid(await exit(), recipient, amount);
    });

    it('до заморозки выхода нет', async () => {
        await deploy(bytes(fixture.blockHash));
        // Деньги на выплату есть: отказ именно из-за того, что rollup не заморожен.
        await rollup.sendDeposit(user.getSender(), { l2Recipient: 0x1234n, value: toNano('5') });
        rejected(await exit(), RollupErrors.rollupNotFrozen);
    });

    it('чужой заголовок не подходит', async () => {
        // Изменён байт в конце заголовка: поля до корня состояния те же, хеш другой.
        rejected(await exit({ headerCell: evmHeaderCell(corrupted(header, header.length - 1)) }), EvmExitErrors.wrongBlockHeader);
    });

    it('изменённый узел доказательства не подходит', async () => {
        // Бит меняется уже в ячейке узла: упаковка та же, байты другие.
        const flipBit = (node: Cell) => {
            const slice = node.beginParse();
            const data = slice.loadBuffer(slice.remainingBits / 8);
            data[data.length - 1] ^= 1;
            const builder = beginCell().storeBuffer(data);
            while (slice.remainingRefs > 0) builder.storeRef(slice.loadRef());
            return builder.endCell();
        };
        for (let index = 0; index < nodes.length; index++) {
            rejected(await exit({ steps: stepsWith(index, flipBit(evmNodeCell(nodes[index]))) }), EvmExitErrors.wrongNodeHash);
        }
    });

    it('доказательство чужого счёта не подходит к этой подписи', async () => {
        // Корень тот же, а дальше путь другого счёта: второй узел не тот, на который ссылается корень.
        const other: Buffer[] = fixture.otherAccountProof.map(bytes);
        expect(other[0].equals(nodes[0])).toBe(true);
        expect(other[1].equals(nodes[1])).toBe(false);
        rejected(await exit({ steps: evmProofSteps(other) }), EvmExitErrors.wrongNodeHash);
    });

    it('подпись под другого получателя не даёт вывести этому', async () => {
        // Из такой подписи восстанавливается другой адрес; чем для него кончится проход по этому
        // доказательству, посчитал генератор фикстуры по правилам дерева.
        const codes: Record<string, number> = {
            wrongNodeHash: EvmExitErrors.wrongNodeHash,
            keyNotInTrie: EvmExitErrors.keyNotInTrie,
        };
        expect(fixture.otherConsentSigner).not.toBe(fixture.account);
        const result = await exit({ signature: fixture.signatureForOtherRecipient });
        rejected(result, codes[fixture.otherConsentExpect]);
        expect(result.transactions).not.toHaveTransaction({ from: rollup.address, to: recipient });
        // А своему получателю та же подпись вывести даёт.
        const other = new Address(0, bytes(fixture.otherRecipientHash));
        paid(await exit({ to: other, signature: fixture.signatureForOtherRecipient }), other, amount);
    });

    it('оборванное и продолженное доказательство не подходят', async () => {
        const steps = evmProofSteps(nodes);
        rejected(await exit({ steps: steps.slice(0, -1) }), EvmExitErrors.keyNotInTrie);
        rejected(await exit({ steps: [...steps, steps[steps.length - 1]] }), EvmExitErrors.badNode);
    });

    it('неверная подсказка о виде узла не проходит', async () => {
        // Лист, выданный за ветку: вместо хеша потомка — строка пути.
        const hinted = (index: number, isBranch: boolean) =>
            evmProofSteps(nodes).map((step, i) => (i === index ? { ...step, isBranch } : step));
        expect(evmNodeItems(nodes[nodes.length - 1]).length).toBe(2);
        rejected(await exit({ steps: hinted(nodes.length - 1, true) }), EvmExitErrors.badRlp);
        // Ветка, выданная за узел с путём: на корне и на втором узле.
        for (const index of [0, 1]) {
            expect(evmNodeItems(nodes[index]).length).toBe(17);
            const result = await exit({ steps: hinted(index, false) });
            rejected(result, branchAsPathOutcome(nodes[index]));
            expect(result.transactions).not.toHaveTransaction({ from: rollup.address, to: recipient });
        }
    });

    it('узел, разрезанный посреди читаемой единицы, отвергается', async () => {
        // Корневая ветка одним куском на ячейку по 100 байт: хеши потомков рвутся границами ячеек.
        const root = nodes[0];
        const pieces: Buffer[] = [];
        for (let offset = 0; offset < root.length; offset += 100) pieces.push(root.subarray(offset, offset + 100));
        rejected(await exit({ steps: stepsWith(0, evmBytesCell(pieces)) }), EvmExitErrors.badEncoding);
    });

    it('узел в двенадцати ячейках принимается, в тринадцати — нет', async () => {
        // Первые `singles` элементов корня — по ячейке на элемент, остальные — сколько поместится.
        const atoms = evmNodeAtoms(nodes[0]);
        const layout = (singles: number) => {
            const chunks = atoms.slice(0, singles);
            let current = Buffer.alloc(0);
            for (const atom of atoms.slice(singles)) {
                if (current.length + atom.length > 127) {
                    chunks.push(current);
                    current = Buffer.alloc(0);
                }
                current = Buffer.concat([current, atom]);
            }
            return current.length > 0 ? [...chunks, current] : chunks;
        };
        const layoutOf = (cells: number) => {
            for (let singles = 0; singles <= atoms.length; singles++) {
                if (layout(singles).length === cells) return layout(singles);
            }
            throw new Error(`корень не раскладывается на ${cells} ячеек`);
        };
        paid(await exit({ steps: stepsWith(0, evmSnake(layoutOf(EVM_MAX_CELLS))) }), recipient, amount);
        await blockchain.loadFrom(frozen);
        rejected(await exit({ steps: stepsWith(0, evmSnake(layoutOf(EVM_MAX_CELLS + 1))) }), EvmExitErrors.badEncoding);
        // Упаковщик строку длиннее предела не соберёт вовсе (куски по целой ячейке: слить их он не может).
        expect(() => evmBytesCell(Array.from({ length: EVM_MAX_CELLS + 1 }, () => Buffer.alloc(127)))).toThrow('не больше');
    });

    describe('негодная раскладка узла по ячейкам', () => {
        const last = nodes.length - 1;
        const leaf = () => {
            const cell = evmNodeCell(nodes[last]);
            expect(cell.refs.length).toBe(0);
            return cell;
        };
        it('две ссылки у ячейки узла: продолжение неоднозначно', async () => {
            rejected(await exit({ steps: stepsWith(last, extended(leaf(), 0, 2)) }), EvmExitErrors.badEncoding);
        });
        it('лишний бит: строка не из целых байтов', async () => {
            rejected(await exit({ steps: stepsWith(last, extended(leaf(), 1, 0)) }), EvmExitErrors.badEncoding);
        });
        it('пустая ячейка в начале строки: читать нечего', async () => {
            rejected(await exit({ steps: stepsWith(last, evmSnake([Buffer.alloc(0), nodes[last]])) }), EvmExitErrors.badEncoding);
        });
        it('пустая ячейка в конце строки: узел не кончился там, где кончились байты', async () => {
            rejected(await exit({ steps: stepsWith(last, evmSnake([nodes[last], Buffer.alloc(0)])) }), EvmExitErrors.badNode);
        });
    });

    it('упаковщик отказывается от строки с хвостом после списка RLP', () => {
        expect(() => evmNodeAtoms(Buffer.concat([nodes[0], Buffer.from([0])]))).toThrow('остались байты');
        expect(() => evmHeaderCell(Buffer.concat([header, Buffer.from([0])]))).toThrow('остались байты');
    });

    it('получатель вне basechain, негодная подпись и нехватка монет отклоняются', async () => {
        rejected(await exit({ to: new Address(-1, bytes(fixture.recipientHash)) }), RollupErrors.wrongRecipient);
        // Негодный номер восстановления: 29 и 31 (то есть 2 и 4 после вычитания 27).
        for (const v of ['1d', '1f']) {
            rejected(await exit({ signature: fixture.signature.slice(0, -2) + v }), EvmExitErrors.badSignature);
        }
        rejected(await exit({ value: budget.minValue - 1n }), RollupErrors.notEnoughValue);
    });

    // Раздел testnet фикстуры появляется, когда генератору дали адрес кошелька прогона.
    (fixture.testnet ? it : it.skip)('счёт для прогона в testnet: те же суммы, что шлёт scripts/runEvmExitTestnet.ts', async () => {
        const exitOf = fixture.testnet;
        const to = Address.parse(exitOf.recipient);
        const sum = BigInt(exitOf.balanceWei) / WEI_PER_NANOTON;
        await deploy(bytes(fixture.blockHash));
        expect(await rollup.getEvmExitConsentHash(big(exitOf.recipientHash))).toBe(big(exitOf.consentHash));
        // Как в прогоне: депозит, который никто не обработает, срок, заморозка.
        const { depositFee } = await rollup.getQueueFees();
        await rollup.sendDeposit(user.getSender(), { l2Recipient: 0xdeadn, value: LATE_DEPOSIT_VALUE, maxFee: depositFee });
        blockchain.now = START + TIMEOUT + 1;
        await rollup.sendActivateEscapeHatch(user.getSender(), ESCAPE_SERVICE_VALUE);
        expect((await rollup.getEscapeState()).frozen).toBe(true);
        // Выход с ровно минимумом монет; выплату покрывает запас развёртывания, депозит цел.
        const result = await rollup.sendForceExitEvm(user.getSender(), {
            recipient: to,
            header: evmHeaderCell(header),
            proof: evmProofCell(evmProofSteps(exitOf.accountProof.map(bytes))),
            signature: evmSignatureCell(evmSignatureFromHex(exitOf.signature)),
            value: budget.minValue,
        });
        paid(result, to, sum);
        gas.forceExitEvmTestnetAccount = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
        expect(await rollup.getOwedPayout(exitNullifierKey(big(exitOf.account)))).toBeNull();
        // Необработанный депозит после выхода возвращается вносителю целиком (за вычетом комиссии очереди).
        const receipt = await rollup.getDepositReceipt(1);
        const refund = await rollup.sendCancelDeposit(user.getSender(), { depositIndex: 1, value: ESCAPE_SERVICE_VALUE });
        expect(refund.transactions).toHaveTransaction({ from: rollup.address, to: user.address, value: receipt!.amount });
        expect(await rollup.getDepositReceipt(1)).toBeNull();
    });

    describe('собранные случаи: формы дерева и узлы с верным хешем, но неверной формой', () => {
        // Расширение, лист в корне, глубокое дерево — в цепочке из шестидесяти счетов их не
        // встретить; узел неверной формы настоящий узел не выдаст вовсе. Случаи и подписи к ним
        // готовит zk/gen-evm-exit-fixture.mjs: под каждый — свой «заголовок» с корнем этого дерева.
        const synthetic = fixture.synthetic;
        const to = new Address(0, bytes(synthetic.recipientHash));
        const cases = synthetic.cases as SyntheticCase[];
        const codes: Record<string, number> = {
            badRlp: EvmExitErrors.badRlp,
            keyNotInTrie: EvmExitErrors.keyNotInTrie,
            badNode: EvmExitErrors.badNode,
            nothingToExit: RollupErrors.nothingToExit,
            insufficientFunds: RollupErrors.insufficientFunds,
        };
        it('набор случаев полон', () => {
            const expectations = cases.map((testCase) => testCase.expect);
            expect(expectations.filter((expectation) => expectation === 'paid').length).toBe(8);
            expect(cases.length).toBe(40);
            expect(new Set(expectations)).toEqual(new Set(['paid', ...Object.keys(codes)]));
            expect(new Set(cases.map((testCase) => testCase.name)).size).toBe(cases.length);
            expect(cases.filter((testCase) => testCase.gas).map((testCase) => testCase.gas)).toEqual(['forceExitEvmDeep']);
        });
        for (const testCase of cases) {
            it(testCase.name, async () => {
                const sum = BigInt(testCase.balanceWei) / WEI_PER_NANOTON;
                await deploy(bytes(testCase.blockHash));
                // Обычно денег у контракта с запасом; в случае «денег меньше суммы» — заведомо меньше.
                await freeze(testCase.underfunded ? toNano('5') : sum + toNano('5'));
                if (testCase.underfunded) expect(sum).toBeGreaterThan(toNano('5') + DEPLOY_VALUE);
                const result = await rollup.sendForceExitEvm(user.getSender(), {
                    recipient: to,
                    header: evmHeaderCell(bytes(testCase.headerRlp)),
                    proof: evmProofCell(evmProofSteps(testCase.proof.map(bytes), testCase.hints)),
                    signature: evmSignatureCell(evmSignatureFromHex(testCase.signature)),
                    // Замер идёт ровно с минимумом монет: его обязано хватить и на самое глубокое дерево.
                    value: testCase.gas ? budget.minValue : exitValue,
                });
                if (testCase.gas) {
                    gas[testCase.gas] = Number(computePhaseOf(result.transactions, rollup.address).gasUsed);
                    // Запас шага, из которого контракт считает минимум монет, покрывает и такое дерево.
                    expect(gas[testCase.gas]).toBeLessThanOrEqual(budget.stepGas);
                }
                if (testCase.expect === 'paid') {
                    expect(sum).toBeGreaterThan(0n);
                    paid(result, to, sum);
                } else {
                    rejected(result, codes[testCase.expect]);
                    expect(result.transactions).not.toHaveTransaction({ from: rollup.address, to });
                }
            });
        }
    });
});
