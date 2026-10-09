#!/usr/bin/env python3
"""Placeholder for the iOS delivery: asks App Store Connect for the app record with the team key.

Proves that APPLE_ASC_KEY, APPLE_ASC_KEY_ID and APPLE_ASC_ISSUER_ID work, and delivers nothing.
Runs under `op run`, which supplies the three values. Prints the app's name and bundle id only.
"""
import base64, json, os, re, subprocess, sys, tempfile, time, urllib.parse, urllib.request

BUNDLE_ID = "com.trommi.ios"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def pem(value: str) -> str:
    # a key may arrive with its line breaks turned into spaces: rebuild the PEM form from its base64 body
    body = re.sub(r"\s", "", re.sub(r"-----[A-Z ]*-----", "", value))
    lines = "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
    return f"-----BEGIN PRIVATE KEY-----\n{lines}\n-----END PRIVATE KEY-----\n"


def raw_signature(der: bytes) -> bytes:
    # openssl gives SEQUENCE { INTEGER r, INTEGER s }; a token wants r and s as 32 bytes each
    assert der[0] == 0x30
    at = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    parts = []
    for _ in range(2):
        assert der[at] == 0x02
        length = der[at + 1]
        parts.append(der[at + 2:at + 2 + length].lstrip(b"\0").rjust(32, b"\0"))
        at += 2 + length
    return parts[0] + parts[1]


def token() -> str:
    now = int(time.time())
    header = {"alg": "ES256", "kid": os.environ["APPLE_ASC_KEY_ID"], "typ": "JWT"}
    claims = {"iss": os.environ["APPLE_ASC_ISSUER_ID"], "iat": now, "exp": now + 300, "aud": "appstoreconnect-v1"}
    signed = b64url(json.dumps(header).encode()) + "." + b64url(json.dumps(claims).encode())
    with tempfile.NamedTemporaryFile("w", suffix=".pem") as key:
        os.chmod(key.name, 0o600)
        key.write(pem(os.environ["APPLE_ASC_KEY"]))
        key.flush()
        der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key.name],
                             input=signed.encode(), capture_output=True, check=True).stdout
    return signed + "." + b64url(raw_signature(der))


def main() -> int:
    if "--self-test" in sys.argv:
        print("token parts:", len(token().split(".")))
        return 0
    query = urllib.parse.urlencode({"filter[bundleId]": BUNDLE_ID, "fields[apps]": "name,bundleId"})
    request = urllib.request.Request("https://api.appstoreconnect.apple.com/v1/apps?" + query,
                                     headers={"Authorization": "Bearer " + token()})
    try:
        with urllib.request.urlopen(request, timeout=30) as answer:
            apps = json.load(answer)["data"]
    except urllib.error.HTTPError as error:
        print(f"App Store Connect refused the key: HTTP {error.code}")
        return 1
    if not apps:
        print(f"App Store Connect answered, but has no app with the bundle id {BUNDLE_ID}")
        return 1
    for app in apps:
        print(f"App Store Connect answered: {app['attributes']['name']} ({app['attributes']['bundleId']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
