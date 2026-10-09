//! A thread that owns a value which may not move between threads, and runs closures on it one after another.
//!
//! The core's device is such a value (it holds trait objects that are not `Send`), while the connector's tasks
//! run on a thread pool. The [`Vault`](crate::vault::Vault) therefore lives on one thread of its own for as long
//! as its [`Keeper`] exists; everything else hands it a closure and awaits the answer.
use crate::error::{Fault, Result};
use std::sync::mpsc;
use std::sync::Mutex;

type Job<T> = Box<dyn FnOnce(&mut T) + Send>;

/// The handle on a kept value. Dropping it ends the thread and drops the value.
pub struct Keeper<T> {
    jobs: Mutex<mpsc::Sender<Job<T>>>,
}

impl<T: 'static> Keeper<T> {
    /// Starts the thread, makes the value on it with `make`, and returns once that is done.
    pub fn spawn(make: impl FnOnce() -> Result<T> + Send + 'static) -> Result<Keeper<T>> {
        let (jobs, inbox) = mpsc::channel::<Job<T>>();
        let (made, wait) = mpsc::channel::<Result<()>>();
        std::thread::Builder::new()
            .name("trommi-vault".into())
            .spawn(move || {
                let mut value = match make() {
                    Ok(value) => {
                        let _ = made.send(Ok(()));
                        value
                    }
                    Err(fault) => {
                        let _ = made.send(Err(fault));
                        return;
                    }
                };
                while let Ok(job) = inbox.recv() {
                    job(&mut value);
                }
            })
            .map_err(|_| Fault::new("internal", "no thread for the vault"))?;
        wait.recv()
            .map_err(|_| Fault::new("internal", "the vault's thread ended"))??;
        Ok(Keeper {
            jobs: Mutex::new(jobs),
        })
    }

    /// Runs `job` on the value and returns its answer.
    pub async fn call<R: Send + 'static>(
        &self,
        job: impl FnOnce(&mut T) -> R + Send + 'static,
    ) -> Result<R> {
        let (answer, wait) = tokio::sync::oneshot::channel();
        let gone = || Fault::new("internal", "the vault's thread ended");
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .send(Box::new(move |value| {
                let _ = answer.send(job(value));
            }))
            .map_err(|_| gone())?;
        wait.await.map_err(|_| gone())
    }
}
