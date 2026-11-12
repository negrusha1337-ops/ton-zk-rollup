import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/generated/verifier_pub32.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
