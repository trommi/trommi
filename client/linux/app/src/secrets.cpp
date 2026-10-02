#include "secrets.h"

#include "link.h"

#include <QDir>
#include <QStandardPaths>

#ifdef TROMMI_LIBSECRET
// GLib has members called "signals".
#undef signals
#include <libsecret/secret.h>

static const SecretSchema *schema()
{
    static SecretSchema s = {};
    if (!s.name) {
        s.name = "de.trommi.Board";
        s.flags = SECRET_SCHEMA_NONE;
        s.attributes[0] = {"app", SECRET_SCHEMA_ATTRIBUTE_STRING};
    }
    return &s;
}
#endif

namespace Secrets {

bool keyringWanted()
{
#ifdef TROMMI_LIBSECRET
    return qEnvironmentVariableIsEmpty("TROMMI_NO_KEYRING");
#else
    return false;
#endif
}

QString filePath()
{
    QString dir = qEnvironmentVariable("XDG_CONFIG_HOME");
    if (dir.isEmpty()) dir = QDir::homePath() + "/.config";
    return dir + "/trommi/board";
}

QString load()
{
#ifdef TROMMI_LIBSECRET
    if (keyringWanted()) {
        GError *error = nullptr;
        gchar *found = secret_password_lookup_sync(schema(), nullptr, &error, "app", "trommi", nullptr);
        if (error) g_error_free(error);
        if (found) {
            const QString link = QString::fromUtf8(found);
            secret_password_free(found);
            if (!link.isEmpty()) return link;
        }
    }
#endif
    return trommi::LinkFile::load(filePath());
}

QString store(const QString &link)
{
#ifdef TROMMI_LIBSECRET
    if (keyringWanted()) {
        GError *error = nullptr;
        const gboolean ok = secret_password_store_sync(schema(), SECRET_COLLECTION_DEFAULT, "Trommi Board", link.toUtf8().constData(),
                                                       nullptr, &error, "app", "trommi", nullptr);
        if (error) g_error_free(error);
        if (ok) {
            trommi::LinkFile::remove(filePath()); // one place only
            return "keyring";
        }
    }
#endif
    return trommi::LinkFile::save(filePath(), link) ? "file" : "";
}

void clear()
{
#ifdef TROMMI_LIBSECRET
    if (keyringWanted()) {
        GError *error = nullptr;
        secret_password_clear_sync(schema(), nullptr, &error, "app", "trommi", nullptr);
        if (error) g_error_free(error);
    }
#endif
    trommi::LinkFile::remove(filePath());
}

}
