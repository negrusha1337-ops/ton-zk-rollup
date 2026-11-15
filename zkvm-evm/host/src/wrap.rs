//! Обёртка готового СЖАТОГО пруфа в Groth16 на процессоре (`--wrap-groth16`).
//!
//! Зачем. На сервере с GPU SDK строит пруф целиком на сервере `sp1-gpu-server`, включая shrink,
//! wrap и gnark; разделить этапы SDK не умеет: у CUDA-прувера один вызов на режим пруфа. Если
//! видеопамяти не хватит на обёртку (карта 24 ГБ), остаётся второй путь: сжатый пруф на GPU
//! (`--prove-compressed`), а shrink → wrap → Groth16 — здесь, на процессоре.
//!
//! Код — перенос того, что SP1 6.10.0 делает в этапах ShrinkWrap и Groth16Wrap своего
//! контроллера: `SP1LocalNode::shrink_wrap` — штатный публичный метод, а сборка свидетеля gnark
//! повторяет `run_groth16` из `sp1-prover-6.10.0/src/worker/prover/recursion.rs` строка в
//! строку (у SDK этот шаг наружу не выведен). При смене версии SP1 сверять с оригиналом.
//!
//! Что защищает от ошибки переноса: gnark сам проверяет построенный пруф (`verify` ниже), затем
//! вызывающий проверяет его штатной проверкой SDK под ключом программы, импортёр — спариванием
//! под закреплённым ключом схемы, контракт — своей проверкой. Неверная обёртка даст пруф,
//! который не пройдёт ни одну из них, а не принятую подделку.
use std::borrow::Borrow;

use anyhow::{anyhow, Context, Result};
use slop_algebra::{AbstractField, PrimeField, PrimeField32};
use slop_bn254::Bn254Fr;
use sp1_hypercube::{koalabears_to_bn254, SP1PcsProofOuter, SP1WrapProof};
use sp1_primitives::{SP1Field, SP1OuterGlobalContext};
use sp1_prover::{
    build::try_build_groth16_artifacts_dir,
    worker::{cpu_worker_builder, SP1LocalNodeBuilder},
};
use sp1_recursion_circuit::{
    machine::SP1ShapedWitnessValues,
    utils::{koalabear_bytes_to_bn254, koalabears_proof_nonce_to_bn254, words_to_bytes},
    witness::{OuterWitness, Witnessable},
};
use sp1_recursion_compiler::config::OuterConfig;
use sp1_recursion_executor::RecursionPublicValues;
use sp1_recursion_gnark_ffi::{Groth16Bn254Prover, Groth16Bn254Proof};
use sp1_sdk::SP1Proof;

/// Сжатый пруф → пруф Groth16 (сам по себе, без публичных значений: их добавляет вызывающий).
/// Время этапов — в журнал: shrink+wrap и gnark отдельно.
pub fn groth16_from_compressed(compressed: &SP1Proof) -> Result<Groth16Bn254Proof> {
    if !matches!(compressed, SP1Proof::Compressed(_)) {
        return Err(anyhow!("в файле не сжатый пруф"));
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().context("рантайм tokio")?;
    runtime.block_on(async {
        let node = SP1LocalNodeBuilder::from_worker_client_builder(cpu_worker_builder())
            .build()
            .await
            .context("не удалось поднять процессорный узел SP1")?;
        let started = std::time::Instant::now();
        let wrapped = node.shrink_wrap(compressed).await.context("shrink/wrap не удался")?;
        println!("[этап] shrink+wrap на процессоре: {:.0} с", started.elapsed().as_secs_f64());
        let started = std::time::Instant::now();
        let proof = groth16_from_wrap(wrapped).await?;
        println!("[этап] gnark Groth16 на процессоре: {:.0} с", started.elapsed().as_secs_f64());
        Ok(proof)
    })
}

/// Повтор `run_groth16` из sp1-prover 6.10.0: свидетель внешней схемы из пруфа wrap и gnark.
async fn groth16_from_wrap(wrapped: SP1WrapProof<SP1OuterGlobalContext, SP1PcsProofOuter>) -> Result<Groth16Bn254Proof> {
    let build_dir = try_build_groth16_artifacts_dir(&wrapped.vk, &wrapped.proof)
        .await
        .context("артефакты схемы Groth16 не установлены")?;
    tokio::task::spawn_blocking(move || -> Result<Groth16Bn254Proof> {
        let SP1WrapProof { vk, proof } = wrapped;
        let input = SP1ShapedWitnessValues { vks_and_proofs: vec![(vk, proof.clone())], is_complete: true };
        let pv: &RecursionPublicValues<SP1Field> = proof.public_values.as_slice().borrow();
        let vkey_hash = koalabears_to_bn254(&pv.sp1_vk_digest);
        let committed_values_digest_bytes: [SP1Field; 32] = words_to_bytes(&pv.committed_value_digest)
            .try_into()
            .map_err(|_| anyhow!("committed_value_digest: ожидалось ровно 32 элемента"))?;
        let committed_values_digest = koalabear_bytes_to_bn254(&committed_values_digest_bytes);
        let exit_code = Bn254Fr::from_canonical_u32(pv.exit_code.as_canonical_u32());
        let proof_nonce = koalabears_proof_nonce_to_bn254(&pv.proof_nonce);
        let vk_root = koalabears_to_bn254(&pv.vk_root);
        let mut witness = OuterWitness::<OuterConfig>::default();
        input.write(&mut witness);
        witness.write_committed_values_digest(committed_values_digest);
        witness.write_vkey_hash(vkey_hash);
        witness.write_exit_code(exit_code);
        witness.write_vk_root(vk_root);
        witness.write_proof_nonce(proof_nonce);
        let prover = Groth16Bn254Prover::new();
        let groth16 = prover.prove(witness, &build_dir);
        prover
            .verify(
                &groth16,
                &vkey_hash.as_canonical_biguint(),
                &committed_values_digest.as_canonical_biguint(),
                &exit_code.as_canonical_biguint(),
                &vk_root.as_canonical_biguint(),
                &proof_nonce.as_canonical_biguint(),
                &build_dir,
            )
            .map_err(|error| anyhow!("gnark не принял собственный пруф: {error}"))?;
        Ok(groth16)
    })
    .await
    .map_err(|error| anyhow!("задача gnark упала: {error}"))?
}
