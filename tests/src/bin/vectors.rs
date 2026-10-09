//! Writes every vector file of the specification into `spec/vectors/`.

use trommi_tests::vectors::{directory, render, FILES};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(directory())?;
    for (name, generate) in FILES {
        let path = directory().join(format!("{name}.json"));
        std::fs::write(&path, render(&generate()?)?)?;
        println!("{}", path.display());
    }
    Ok(())
}
