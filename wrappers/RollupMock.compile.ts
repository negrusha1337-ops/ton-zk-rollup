import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/rollup_mock.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
