import { mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Address, beginCell, Cell, Dictionary, toNano, Transaction } from '@ton/core';
import { compile } from '@ton/blueprint';
import { Blockchain, BlockchainSnapshot, createShardAccount, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { mnemonicNew } from '@ton/crypto';
import { Bn254VerifierOpcodes } from '../wrappers/Bn254Groth16Verifier';
import { loadEvmRollupKey, loadRethExpected } from '../wrappers/evmProofs';
import { Rollup } from '../wrappers/Rollup';
import { deploy, DeployInputs, deployConfig, DeployRefused, networkForwardPrices, serviceCommands } from '../sequencer/deploy';
import { randomChainId, usedChainIds } from '../sequencer/chainId';
import { serialize } from '../sequencer/state';
import { checkTestnet, MIN_WALLET_BALANCE } from '../sequencer/testnet';
import { rateLimiter } from '../sequencer/queue/toncenter';
import { SequencerWallet, ToncenterChain } from '../sequencer/ton';
import { sandboxChain } from './helpers/sandboxChain';

// Развёртывание контракта кошельком сервиса (`sequencer/main.ts deploy`, sequencer/deploy.ts) в
// Sandbox: настоящий контракт и ключ программы EVM, кошелёк v5r1 по новой мнемонике, сеть —
// подставная (tests/helpers/sandboxChain.ts): потерянные ответы, недошедшие сообщения, чужой
// global_id. Проверяется: адрес до отправки и --dry-run без отправок; полный путь и сверка;
// возобновление без дублей; отказы — каждый с точной причиной и без единой отправки.
// Чего здесь нет: toncenter, настоящие комиссии кошелька и время блоков testnet.

const WORK = path.join(__dirname, '..', '.tools', 'sequencer-test', 'deploy');
const key = loadEvmRollupKey();
// chainId — свой у развёртывания (круг 23, пункт 2): случайный, не бывший в прогонах.
const expected = { chainId: randomChainId(usedChainIds()).toString(), genesisHash: loadRethExpected().genesisHash };
const PARAMS = { escapeTimeout: 21600, maxBlockAge: 3600, expectedProofTime: 1800 };

describe('deploy: развёртывание rollup v2 кошельком сервиса', () => {
    let blockchain: Blockchain;
    let funder: SandboxContract<TreasuryContract>;
    let wallet: SequencerWallet;
    let code: Cell;
    let nullifierCode: Cell;
    let funded: BlockchainSnapshot;
    let dir: string;
    let net: ReturnType<typeof sandboxChain>;
    let lines: string[];

    const inputs = (overrides: Partial<DeployInputs> = {}): DeployInputs => ({
        chain: net.chain,
        wallet,
        stateDir: dir,
        params: PARAMS,
        dryRun: false,
        log: (line) => lines.push(line),
        code,
        nullifierCode,
        key,
        chainSource: expected,
        forward: networkForwardPrices(),
        reserve: MIN_WALLET_BALANCE,
        submitter: { pollMs: 0, pollAttempts: 20, now: () => blockchain.now! },
        ...overrides,
    });
    const address = (params = PARAMS) => Rollup.createFromConfig(deployConfig({ wallet, params, nullifierCode, chainSource: expected }), code).address;
    const rollup = () => blockchain.openContract(Rollup.createFromAddress(address()));
    /** Успешные транзакции контракта по опкодам (развёртывание — пустое тело, код 0). */
    const ops = () =>
        net.results
            .flatMap((result) => result.transactions)
            .flatMap((transaction: Transaction) => {
                const message = transaction.inMessage;
                if (!message || message.info.type !== 'internal' || !address().equals(message.info.dest)) return [];
                const description = transaction.description;
                if (description.type !== 'generic' || description.computePhase.type !== 'vm' || !description.computePhase.success) return [];
                const body = message.body.beginParse();
                return [body.remainingBits >= 32 ? body.loadUint(32) : 0];
            });
    const plain = (result: { address: Address; status: string; sent: number }) => ({ ...result, address: result.address.toRawString() });
    const refusal = async (promise: Promise<unknown>) => {
        const error = await promise.then(() => new Error('deploy не отказал'), (reason: Error) => reason);
        expect(net.attempts).toHaveLength(0);
        return error;
    };

    beforeAll(async () => {
        code = await compile('Rollup');
        nullifierCode = await compile('RollupNullifier');
        wallet = await SequencerWallet.fromEnv({ SEQUENCER_MNEMONIC: (await mnemonicNew()).join(' '), SEQUENCER_WALLET_VERSION: 'v5r1' });
        blockchain = await Blockchain.create();
        blockchain.now = 1_800_000_000;
        funder = await blockchain.treasury('funder');
        await funder.send({ to: wallet.address, value: toNano('2'), bounce: false });
        funded = blockchain.snapshot();
    }, 120_000);
    beforeEach(async () => {
        await blockchain.loadFrom(funded);
        dir = path.join(WORK, randomBytes(4).toString('hex'));
        mkdirSync(dir, { recursive: true });
        net = sandboxChain(blockchain);
        lines = [];
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('--dry-run: адрес контракта, адрес кошелька и потребность — без единой отправки', async () => {
        expect(plain(await deploy(inputs({ dryRun: true })))).toEqual({ address: address().toRawString(), status: 'dry-run', sent: 0 });
        expect(net.attempts).toHaveLength(0);
        const text = lines.join('\n');
        expect(text).toContain(`контракт: ${address().toString({ testOnly: true })}`);
        expect(text).toContain(wallet.address.toString({ testOnly: true, bounceable: false }));
        expect(text).toMatch(/нужно: сообщения 0\.065 TON \+ комиссии кошелька около [\d.]+ TON \+ остаток сервису 0\.2 TON = [\d.]+ TON; на кошельке 2 TON/);
        expect(text).toMatch(/режим --dry-run: ничего не отправлено \(14 сообщений к отправке\)/);
        // Адрес зависит от параметров: другой срок — другой контракт.
        expect(address({ ...PARAMS, escapeTimeout: 21601 }).equals(address())).toBe(false);
    }, 60_000);

    it('полный путь: развёртывание, 12 частей ключа, FinalizeKey, сверка; повтор ничего не шлёт', async () => {
        expect(plain(await deploy(inputs()))).toEqual({ address: address().toRawString(), status: 'deployed', sent: 14 });
        expect(ops()).toEqual([0, ...Array(12).fill(Bn254VerifierOpcodes.uploadKeyPart), Bn254VerifierOpcodes.finalizeKey]);
        const opened = rollup();
        expect(await opened.getKeyHash()).toBe(key.keyHash);
        expect(await opened.getDeployment()).toMatchObject({ chainId: BigInt(expected.chainId), escapeTimeout: 21600, maxBlockAge: 3600 });
        expect((await opened.getDeployment()).sequencer.equals(wallet.address)).toBe(true);
        expect(lines.join('\n')).toMatch(/развёртывание сверено/);
        // Сетевая часть `check` сервиса принимает этот контракт как есть: секвенсор, ключ, генезис, срок, кошелёк.
        const report = await checkTestnet({ chain: net.chain, rollup: address(), wallet, now: () => blockchain.now!, expectedProofTime: PARAMS.expectedProofTime });
        expect(report.problems).toEqual([]);

        lines = [];
        expect(plain(await deploy(inputs()))).toEqual({ address: address().toRawString(), status: 'already', sent: 0 });
        expect(net.attempts).toHaveLength(14);
        expect(lines.join('\n')).toMatch(/контракт уже развёрнут, ключ зафиксирован: отправлять нечего/);
        const [checkLine, runLine] = serviceCommands(address(), PARAMS, dir, dir);
        expect(checkLine).toBe(`npx ts-node sequencer/main.ts check ${address().toString({ testOnly: true })} --fee-recipient=0x<адрес L2 секвенсора>`);
        expect(runLine).toMatch(/^tmux new -s sequencer 'npx ts-node sequencer\/main\.ts run /);
    }, 120_000);

    it('прервано посреди ключа: ответ потерян либо сообщение не дошло — повтор продолжает без дублей', async () => {
        net.control.fault = { kind: 'loseAck' };
        net.control.which = (index) => index === 5;
        await expect(deploy(inputs())).rejects.toThrow('сеть не ответила (сообщение дошло)');
        net.control.fault = { kind: 'drop' };
        net.control.which = (index) => index === 9;
        await expect(deploy(inputs())).rejects.toThrow('сеть не ответила (сообщение не дошло)');
        net.control.fault = null;
        net.control.tick = 30; // время L1 идёт: срок недошедшего сообщения истечёт
        lines = [];
        expect(await deploy(inputs())).toMatchObject({ status: 'deployed' });
        // Учтены развёртывание и части 1–7 (отправки 2–8; девятая не дошла): осталось пять частей и фиксация.
        expect(lines.join('\n')).toMatch(/развёртывание начато раньше: осталось 6 сообщений/);
        // Каждый шаг учтён контрактом ровно один раз; недошедшее отправлено повторно.
        expect(ops()).toEqual([0, ...Array(12).fill(Bn254VerifierOpcodes.uploadKeyPart), Bn254VerifierOpcodes.finalizeKey]);
        expect(net.attempts).toHaveLength(15);
        expect(await rollup().getKeyHash()).toBe(key.keyHash);
    }, 120_000);

    it('часть ключа в контракте подменена после загрузки: FinalizeKey не отправляется', async () => {
        const parts = 12;
        const { chain } = net;
        // После последней части — подменить первую в данных контракта (как если бы её перезаписали).
        const corrupting = {
            ...chain,
            sendExternal: async (message: Cell) => {
                await chain.sendExternal(message);
                if (net.attempts.length !== 1 + parts) return;
                const contract = await blockchain.getContract(address());
                const shard = contract.account;
                const state = shard.account!.storage.state;
                if (state.type !== 'active') throw new Error('контракт не развёрнут');
                const root = state.state.data!.beginParse();
                const bits = root.loadBits(root.remainingBits);
                const [keys, nullifier, storage] = [root.loadRef(), root.loadRef(), root.loadRef()];
                const slice = keys.beginParse();
                const vk = slice.loadMaybeRef();
                const dict = slice.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
                const first = Math.min(...dict.keys());
                dict.set(first, beginCell().storeUint(1, 8).endCell());
                const newKeys = beginCell().storeMaybeRef(vk).storeDict(dict).endCell();
                state.state.data = beginCell().storeBits(bits).storeRef(newKeys).storeRef(nullifier).storeRef(storage).endCell();
                await blockchain.setShardAccount(address(), shard);
            },
        };
        const error = await deploy(inputs({ chain: corrupting })).then(() => new Error('не отказал'), (reason: Error) => reason);
        expect(error.message).toMatch(/^перед фиксацией ключа части \d+ в контракте не те, что в key\.json: FinalizeKey не отправлен$/);
        expect(net.attempts).toHaveLength(1 + parts);
        expect(await rollup().getKeyHash()).toBe(0n);
    }, 120_000);

    describe('отказы: точная причина и ни одной отправки', () => {
        it('по адресу уже активен чужой контракт: другой владелец; зафиксирован другой ключ', async () => {
            const foreign = async (data: Cell) =>
                blockchain.setShardAccount(address(), createShardAccount({ address: address(), code, data, balance: toNano('1') }));
            const config = deployConfig({ wallet, params: PARAMS, nullifierCode, chainSource: expected });
            await foreign(Rollup.buildData({ ...config, owner: funder.address }));
            const owner = await refusal(deploy(inputs()));
            expect(owner).toBeInstanceOf(DeployRefused);
            expect(owner.message).toMatch(/уже активен контракт с другим состоянием: владелец .* а не кошелёк сервиса\. Ничего не отправлено/);
            await foreign(Rollup.buildData(config, { vkData: new Cell() }));
            expect((await refusal(deploy(inputs()))).message).toMatch(/уже активен контракт с другим состоянием: зафиксирован ключ 0x[0-9a-f]+, а не ключ из key\.json/);
        }, 60_000);

        it('на кошельке не хватает на развёртывание и остаток сервису', async () => {
            await blockchain.loadFrom(funded);
            const poor = await SequencerWallet.fromEnv({ SEQUENCER_MNEMONIC: (await mnemonicNew()).join(' '), SEQUENCER_WALLET_VERSION: 'v5r1' });
            await funder.send({ to: poor.address, value: toNano('0.25'), bounce: false });
            const error = await refusal(deploy(inputs({ wallet: poor })));
            expect(error.message).toMatch(/^на кошельке 0\.25 TON, нужно [\d.]+ TON: не хватает [\d.]+ TON\. Ничего не отправлено$/);
        }, 60_000);

        it('сеть не testnet: global_id mainnet; адрес API не testnet.toncenter.com', async () => {
            net.control.globalId = -239;
            expect((await refusal(deploy(inputs()))).message).toBe('сеть с global_id -239 — не testnet (-3): ничего не отправлено');
            expect(() => new ToncenterChain({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', limit: rateLimiter(1) })).toThrow(
                'адрес API toncenter.com: секвенсор работает только с testnet.toncenter.com (стенд без аудита)',
            );
        });

        it('параметры вне границ контракта и сервиса; генезис цепочки не тот', async () => {
            const params = (overrides: Partial<typeof PARAMS>) => refusal(deploy(inputs({ params: { ...PARAMS, ...overrides } })));
            expect((await params({ escapeTimeout: 1800, maxBlockAge: 1800, expectedProofTime: 600 })).message).toMatch(
                /контракт не зафиксирует ключ: срок заморозки 1800 с меньше допустимых 3600 с/,
            );
            expect((await params({ maxBlockAge: 30000 })).message).toMatch(/контракт не зафиксирует ключ: возраст блока 30000 с больше срока заморозки 21600 с/);
            expect((await params({ maxBlockAge: 2400 })).message).toMatch(/сервис не запустится: время проверки кандидата 300 с \+ время пруфа 1800 с \+ запас 300 с = 2400 с не меньше maxBlockAge 2400 с/);
            const genesis = await refusal(deploy(inputs({ chainSource: { ...expected, genesisHash: '0x' + '11'.repeat(32) } })));
            expect(genesis.message).toMatch(/генезис цепочки Reth \(expected\.json\) 0x1111.*, а константа протокола сервиса 0xc0284e91/);
            // chainId, которого не примут программа (Linea) или генезис узла (больше 2^53 − 1).
            expect((await refusal(deploy(inputs({ chainSource: { ...expected, chainId: '59144' } })))).message).toMatch(/chainId 59144 — сеть Linea: программа батча такие отвергает/);
            expect((await refusal(deploy(inputs({ chainSource: { ...expected, chainId: String(2n ** 53n) } })))).message).toMatch(/chainId 9007199254740992 — не число от 1 до 2\^53 − 1/);
            const keyCheck = await refusal(deploy(inputs({ keyCheck: () => 'части ключа не те' })));
            expect(keyCheck.message).toMatch(/key\.json не сходится с исходниками программы: части ключа не те/);
        }, 60_000);

        it('каталог состояния от прежнего контракта; исходящий журнал — сообщение другому контракту', async () => {
            writeFileSync(path.join(dir, 'state.json'), '{}');
            expect((await refusal(deploy(inputs()))).message).toMatch(/уже есть .*state\.json — от прежнего контракта: задайте новый --state-dir/);
            rmSync(path.join(dir, 'state.json'));
            const other = new Address(0, Buffer.alloc(32, 9)).toRawString();
            writeFileSync(
                path.join(dir, 'outbox.json'),
                serialize({ what: 'батч 7', seqno: 3, validUntil: 1, effect: { kind: 'batchIndex', atLeast: 7 }, messageHash: '00', sentAt: '', rollup: other }),
            );
            expect((await refusal(deploy(inputs()))).message).toMatch(
                new RegExp(`развёртывание контракта: в .*outbox\\.json — сообщение «батч 7» другому контракту \\(${other}\\)`),
            );
        }, 60_000);
    });
});
