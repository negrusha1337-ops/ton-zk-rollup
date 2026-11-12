import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/rollup.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
