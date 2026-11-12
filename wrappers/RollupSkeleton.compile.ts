import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/rollup_skeleton.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
