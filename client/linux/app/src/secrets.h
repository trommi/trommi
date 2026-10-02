// Where the board link (address and token) is kept between starts: the
// desktop's Secret Service (GNOME Keyring, KWallet, KeePassXC) through
// libsecret, else a file only its owner can read.
#pragma once

#include <QString>

namespace Secrets {

// TROMMI_NO_KEYRING=1 (and every test and screenshot) keeps to the file.
bool keyringWanted();
QString filePath(); // $XDG_CONFIG_HOME/trommi/board

QString load();
// Returns where it went: "keyring", "file", or "" if neither took it.
QString store(const QString &link);
void clear();

}
