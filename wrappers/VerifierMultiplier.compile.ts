import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/generated/verifier_multiplier.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
