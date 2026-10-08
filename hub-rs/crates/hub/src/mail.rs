//! How the hub sends mail (hub/mail.mjs): HUB_MAIL_TRANSPORT log (default), outbox (HUB_MAIL_OUTBOX, a JSON file
//! per mail, for tests), off. No real provider yet, as on the Node hub.

use crate::config::Config;
use serde_json::json;
use std::path::PathBuf;

pub struct Mailer {
    pub transport: String,
    outbox: Option<PathBuf>,
}
impl Mailer {
    pub fn new(cfg: &Config) -> Result<Mailer, String> {
        let outbox = cfg.get("HUB_MAIL_OUTBOX").map(PathBuf::from);
        let transport = cfg.get("HUB_MAIL_TRANSPORT").map(String::from).unwrap_or_else(|| if outbox.is_some() { "outbox".into() } else { "log".into() });
        if transport == "outbox" && outbox.is_none() {
            return Err("HUB_MAIL_TRANSPORT=outbox needs HUB_MAIL_OUTBOX".into());
        }
        if let Some(o) = &outbox {
            std::fs::create_dir_all(o).map_err(|e| e.to_string())?;
        }
        Ok(Mailer { transport, outbox })
    }
    pub fn send(&self, to: &str, subject: &str, text: &str, log: &dyn Fn(&str)) -> std::io::Result<()> {
        match self.transport.as_str() {
            "off" => Ok(()),
            "outbox" => {
                let file = self.outbox.as_ref().unwrap().join(format!("{}-{}.json", crate::util::wall(), zcrypto::hex(&crate::util::random_bytes(4))));
                crate::push::write_private(&file, serde_json::to_string(&json!({ "to": to, "subject": subject, "text": text, "at": crate::util::wall() })).unwrap().as_bytes())
            }
            _ => {
                let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
                log(&format!("mail (log transport) to {to}: {subject} | {flat}"));
                Ok(())
            }
        }
    }
}
