import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/bn254_bench.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
