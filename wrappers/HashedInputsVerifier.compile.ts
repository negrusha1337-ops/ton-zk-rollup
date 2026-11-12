import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/hashed_inputs_verifier.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
