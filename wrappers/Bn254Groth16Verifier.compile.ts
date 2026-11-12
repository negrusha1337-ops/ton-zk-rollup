import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tolk',
    entrypoint: 'contracts/bn254_groth16_verifier.tolk',
    withStackComments: false,
    withSrcLineComments: false,
};
