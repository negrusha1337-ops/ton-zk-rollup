use sp1_build::build_program_with_args;

fn main() {
    // Две гостевые программы: батчи и аварийный выход.
    build_program_with_args("../program", Default::default());
    build_program_with_args("../exit-program", Default::default());
}
