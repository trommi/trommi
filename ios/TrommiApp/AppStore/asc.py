#!/usr/bin/env python3
"""App Store Connect API steps of the TestFlight workflow (.github/workflows/ios-beta.yml). Standard library only; the
JWT is signed with the openssl command line tool, so it runs on a stock macOS runner and on Linux alike.

  asc.py prepare BUNDLE_ID          the bundle id (Push Notifications, App Groups, Associated Domains) and
                                    BUNDLE_ID.share, .notify, .live (App Groups) are registered, their INVALID App Store
                                    profiles removed; the app record exists
  asc.py wait VERSION BUILD         waits until App Store Connect has processed that build (VALID), then prints its id
  asc.py internal BUILD_ID GROUP [EMAIL]
                                    the internal TestFlight group GROUP exists (every build), holds BUILD_ID, and
                                    EMAIL (a user of the team) is one of its testers
  asc.py notes BUILD_ID TEXT        TestFlight "What to Test" of that build (every localization; de-DE if none)
  asc.py next-build                 the highest build number App Store Connect has for the app, plus one
  asc.py last-sha                   the commit of the newest build whose What to Test names one ("(abc1234)")
  asc.py export-code                the code of the app's APPROVED export compliance documentation (the newest if
                                    several), read only; fails listing every declaration's state and date if none is

Environment: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 file). Nothing here prints key material or tokens.
"""
import base64, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

API = "https://api.appstoreconnect.apple.com"


def die(msg):
    print(f"::error::{msg}", flush=True)
    sys.exit(1)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(sig):
    # ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } -> r || s, 32 bytes each (JWS ES256).
    assert sig[0] == 0x30
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    out = b""
    for _ in range(2):
        assert sig[i] == 0x02
        n = sig[i + 1]
        out += sig[i + 2:i + 2 + n].lstrip(b"\0").rjust(32, b"\0")
        i += 2 + n
    return out


_token = (0, "")


def token():
    global _token
    now = int(time.time())
    if _token[0] > now + 60:
        return _token[1]
    key_id, issuer, path = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"], os.environ["ASC_KEY_PATH"]
    head = b64url(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}).encode())
    claims = b64url(json.dumps({"iss": issuer, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"}).encode())
    signed = f"{head}.{claims}".encode()
    der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", path], input=signed, capture_output=True, check=True).stdout
    _token = (now + 1200, f"{head}.{claims}.{b64url(der_to_raw(der))}")
    return _token[1]


def call(method, path, body=None, ok=()):
    """ok: HTTP error codes that are expected answers (the call then returns {})."""
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        if e.code in ok:
            return {"error": e.code, "detail": "; ".join(x.get("detail", "") for x in _errors(text))}
        die(f"{method} {path}: HTTP {e.code} {text}")
    return json.loads(raw) if raw else {}


def _errors(text):
    try:
        return json.loads(text).get("errors", [])
    except ValueError:
        return [{"detail": text[:300]}]


def rel(kind, ident):
    return {"data": {"type": kind, "id": ident}}


def q(s):
    return urllib.parse.quote(s, safe="")


def app_id(bundle):
    apps = [a for a in call("GET", f"/v1/apps?filter[bundleId]={q(bundle)}")["data"]
            if a["attributes"]["bundleId"] == bundle]
    return apps[0]["id"] if apps else None


def bundle_id(identifier, name, wanted):
    """The bundle id registered, with every capability in `wanted` turned on."""
    found = [b for b in call("GET", f"/v1/bundleIds?filter[identifier]={q(identifier)}&limit=200")["data"]
             if b["attributes"]["identifier"] == identifier]
    if found:
        bid = found[0]["id"]
    else:
        print(f"registering bundle id {identifier}")
        bid = call("POST", "/v1/bundleIds", {"data": {"type": "bundleIds", "attributes": {
            "identifier": identifier, "name": name, "platform": "IOS"}}})["data"]["id"]
    caps = [c["attributes"]["capabilityType"] for c in call("GET", f"/v1/bundleIds/{bid}/bundleIdCapabilities")["data"]]
    for cap in wanted:
        if cap not in caps:
            print(f"turning on {cap} for {identifier}")
            call("POST", "/v1/bundleIdCapabilities", {"data": {"type": "bundleIdCapabilities",
                 "attributes": {"capabilityType": cap}, "relationships": {"bundleId": rel("bundleIds", bid)}}})
    print(f"bundle id {identifier}: {bid}, capabilities {sorted(set(caps) | set(wanted))}")
    return bid


def prepare(bundle):
    # The app (push, the App Group of its extensions, universal links of app.trommi.com) and its extensions: Share, the
    # Notification Service Extension, the Live Activity widget (each the App Group). The API turns the App Groups
    # capability on but cannot create the group or assign it: group.com.trommi.ios is made and assigned to every id once
    # in the developer portal (ios/README.md "Share Extension"). Communication Notifications (the session's drawing on a
    # push) is no capability type of the API: ticked once in the portal (ios/README.md "Push").
    bundle_id(bundle, "Trommi", ["PUSH_NOTIFICATIONS", "APP_GROUPS", "ASSOCIATED_DOMAINS"])
    extensions = [(f"{bundle}.share", "Trommi Share"), (f"{bundle}.notify", "Trommi Notify"), (f"{bundle}.live", "Trommi Live")]
    for ident, name in extensions:
        bundle_id(ident, name, ["APP_GROUPS"])
    # A capability change makes the profiles INVALID; their names stay taken, and omarchy-apple-dev's identity step
    # (which looks only at ACTIVE ones) could not make new ones under the same name (409). They go here.
    for ident in (bundle, *(i for i, _ in extensions)):
        for p in call("GET", f"/v1/profiles?filter[profileType]=IOS_APP_STORE&limit=200")["data"]:
            name, state = p["attributes"]["name"], p["attributes"]["profileState"]
            if name.startswith(f"omarchy-apple-dev {ident} ") and state != "ACTIVE":
                print(f"removing the {state} profile '{name}'")
                call("DELETE", f"/v1/profiles/{p['id']}")
    aid = app_id(bundle)
    if not aid:
        die(f"no App Store Connect app record for {bundle}: create it once in App Store Connect (Apps > + > New App; "
            "the API cannot create apps), ios/README.md 'TestFlight from CI'")
    gh_out("app_id", aid)


def wait(version, build):
    aid = app_id(os.environ["BUNDLE_ID"]) or die("no app record")
    # The build shows up a few minutes after the upload, then goes PROCESSING -> VALID (or FAILED / INVALID).
    for i in range(80):
        rows = call("GET", f"/v1/builds?filter[app]={aid}&filter[version]={q(build)}"
                           f"&filter[preReleaseVersion.version]={q(version)}&limit=1")["data"]
        state = rows[0]["attributes"]["processingState"] if rows else "not there yet"
        print(f"attempt {i + 1}: build {version} ({build}): {state}", flush=True)
        if state == "VALID":
            attrs = rows[0]["attributes"]
            print(f"usesNonExemptEncryption: {attrs.get('usesNonExemptEncryption')}")
            if attrs.get("usesNonExemptEncryption") is None:
                print("::warning::export compliance is not answered for this build: testers cannot install it until "
                      "it is answered in App Store Connect (TestFlight > the build), or the variable "
                      "ITS_NON_EXEMPT_ENCRYPTION (YES or NO) answers it for every build (ios/README.md)")
            gh_out("build_id", rows[0]["id"])
            return
        if state in ("FAILED", "INVALID"):
            die(f"App Store Connect could not process build {version} ({build}): {state} (the e-mail to the account "
                "holder names the reason)")
        time.sleep(30)
    die(f"build {version} ({build}) was not processed within 40 minutes")


def internal(build_id, group, email=""):
    aid = app_id(os.environ["BUNDLE_ID"]) or die("no app record")
    groups = [g for g in call("GET", f"/v1/apps/{aid}/betaGroups?limit=200")["data"]
              if g["attributes"]["name"] == group]
    if groups:
        gid = groups[0]["id"]
        every = groups[0]["attributes"].get("hasAccessToAllBuilds")
    else:
        print(f"creating the internal group {group}")
        g = call("POST", "/v1/betaGroups", {"data": {"type": "betaGroups", "attributes": {
            "name": group, "isInternalGroup": True, "hasAccessToAllBuilds": True},
            "relationships": {"app": rel("apps", aid)}}})["data"]
        gid, every = g["id"], g["attributes"].get("hasAccessToAllBuilds")
    if not every:
        call("POST", f"/v1/betaGroups/{gid}/relationships/builds", {"data": [{"type": "builds", "id": build_id}]})
    print(f"group {group} ({gid}): build {build_id} {'(the group gets every build)' if every else 'added'}")
    if email:
        testers = call("GET", f"/v1/betaGroups/{gid}/betaTesters?limit=200")["data"]
        if any(t["attributes"].get("email", "").lower() == email.lower() for t in testers):
            print("the tester is in the group")
        else:
            # Internal testers must be users of the team; Apple answers 409 when the address is not one.
            added = call("POST", "/v1/betaTesters", {"data": {"type": "betaTesters", "attributes": {"email": email},
                         "relationships": {"betaGroups": {"data": [{"type": "betaGroups", "id": gid}]}}}}, ok=(409,))
            if "error" not in added:
                print("tester added to the group")
            else:
                users = call("GET", f"/v1/users?filter[username]={q(email)}&limit=5")["data"]
                roles = users[0]["attributes"].get("roles") if users else None
                print(f"team user {email}: {'roles ' + str(roles) if users else 'not found'}")
                print(f"::warning::App Store Connect did not take {email} as an internal tester (409: "
                      f"{added['detail']}): add the tester in App Store Connect (TestFlight > {group}); internal "
                      "testers must be users of the team")


def notes(build_id, text):
    text = text.strip()[:4000]
    locs = call("GET", f"/v1/builds/{build_id}/betaBuildLocalizations?limit=50")["data"]
    for loc in locs:
        call("PATCH", f"/v1/betaBuildLocalizations/{loc['id']}", {"data": {"type": "betaBuildLocalizations",
             "id": loc["id"], "attributes": {"whatsNew": text}}})
        print(f"What to Test ({loc['attributes'].get('locale')}): {text}")
    if not locs:
        call("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations",
             "attributes": {"locale": "de-DE", "whatsNew": text}, "relationships": {"build": rel("builds", build_id)}}})
        print(f"What to Test (de-DE): {text}")


def builds(aid):
    rows, path = [], f"/v1/builds?filter[app]={aid}&limit=200&fields[builds]=version,uploadedDate"
    while path:
        page = call("GET", path)
        rows += page["data"]
        nxt = page.get("links", {}).get("next")
        path = nxt[len(API):] if nxt else None
    return rows


def next_build():
    aid = app_id(os.environ["BUNDLE_ID"]) or die("no app record")
    numbers = [int(b["attributes"]["version"]) for b in builds(aid) if b["attributes"]["version"].isdigit()]
    print(max(numbers, default=0) + 1)


def last_sha():
    aid = app_id(os.environ["BUNDLE_ID"]) or die("no app record")
    newest = sorted(builds(aid), key=lambda b: b["attributes"].get("uploadedDate") or "", reverse=True)
    for b in newest[:20]:
        for loc in call("GET", f"/v1/builds/{b['id']}/betaBuildLocalizations?limit=50")["data"]:
            m = re.search(r"\(([0-9a-f]{7,40})\)", loc["attributes"].get("whatsNew") or "")
            if m:
                print(m.group(1))
                return


def pick_code(rows):
    """Of the app's encryption declarations (the API's `data`), the APPROVED one's code, the newest if several: (code,
    state, date). None when none is approved."""
    def date(r):
        a = r.get("attributes") or {}
        return a.get("uploadedDate") or a.get("createdDate") or ""
    approved = [r for r in rows if (r.get("attributes") or {}).get("appEncryptionDeclarationState") == "APPROVED"
                and (r.get("attributes") or {}).get("codeValue")]
    if not approved:
        return None
    best = sorted(approved, key=date, reverse=True)[0]
    return best["attributes"]["codeValue"], "APPROVED", date(best)


def export_code():
    aid = app_id(os.environ["BUNDLE_ID"])
    if not aid:
        print("::error::no app record", file=sys.stderr, flush=True)
        sys.exit(1)
    rows, path = [], f"/v1/apps/{aid}/appEncryptionDeclarations?limit=200"
    while path:
        page = call("GET", path)
        rows += page["data"]
        nxt = page.get("links", {}).get("next")
        path = nxt[len(API):] if nxt else None
    picked = pick_code(rows)
    if not picked:
        listed = ", ".join(f"{(r.get('attributes') or {}).get('appEncryptionDeclarationState', '?')} "
                           f"({(r.get('attributes') or {}).get('uploadedDate') or (r.get('attributes') or {}).get('createdDate') or 'no date'})"
                           for r in rows) or "none"
        # (on stderr: stdout is the code the script takes)
        print(f"::error::no APPROVED export compliance documentation for {os.environ['BUNDLE_ID']} in App Store Connect "
              f"(declarations: {listed}); set the repository variable IOS_EXPORT_COMPLIANCE_CODE or wait for the approval",
              file=sys.stderr, flush=True)
        sys.exit(1)
    code, state, when = picked
    print(f"export compliance code from App Store Connect: {code} ({state}, {when or 'no date'})", file=sys.stderr)
    print(code)


def gh_out(name, value):
    print(f"{name}: {value}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"{name}={value}\n")


if __name__ == "__main__":
    cmds = {"prepare": prepare, "wait": wait, "internal": internal, "notes": notes, "next-build": next_build,
            "last-sha": last_sha, "export-code": export_code}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])
