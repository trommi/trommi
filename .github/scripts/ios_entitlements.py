#!/usr/bin/env python3
"""Checks that a signed Trommi.app and its three extensions carry their entitlements files, value for value.

    ios_entitlements.py <AppStore folder> <Trommi.app> [--distribution]

Every entry of TrommiApp.entitlements must be in the app's signature, and each extension's file in its own
signature (TrommiShare, TrommiNotify, TrommiLive). A signature may carry more (application-identifier, the team);
it may not carry less or another value. With --distribution the app's signature must also name a team and say
get-task-allow false (a build App Store Connect takes). Exit 1 names every difference."""
import plistlib
import subprocess
import sys
from pathlib import Path

PARTS = [
    ("", "TrommiApp.entitlements"),
    ("PlugIns/TrommiShare.appex", "TrommiShare.entitlements"),
    ("PlugIns/TrommiNotify.appex", "TrommiNotify.entitlements"),
    ("PlugIns/TrommiLive.appex", "TrommiLive.entitlements"),
]


def signed(bundle: Path) -> dict:
    out = subprocess.run(["codesign", "-d", "--entitlements", "-", "--xml", str(bundle)],
                         capture_output=True, check=False)
    if out.returncode != 0:
        raise SystemExit(f"::error::{bundle.name} is not signed: {out.stderr.decode(errors='replace').strip()}")
    return plistlib.loads(out.stdout) if out.stdout.strip() else {}


def main() -> int:
    appstore, app = Path(sys.argv[1]), Path(sys.argv[2])
    distribution = "--distribution" in sys.argv[3:]
    wrong = []
    for sub, name in PARTS:
        bundle = app / sub if sub else app
        want = plistlib.loads((appstore / name).read_bytes())
        have = signed(bundle)
        for key, value in want.items():
            if key not in have:
                wrong.append(f"{bundle.name}: {key} is missing")
            elif have[key] != value:
                wrong.append(f"{bundle.name}: {key} is {have[key]!r}, the file says {value!r}")
        if distribution:
            if have.get("get-task-allow") is not False:
                wrong.append(f"{bundle.name}: get-task-allow is {have.get('get-task-allow')!r}, not false")
            if not have.get("com.apple.developer.team-identifier"):
                wrong.append(f"{bundle.name}: no team identifier")
        print(f"{bundle.name}: {len(want)} entitlements as in {name}" + (" (distribution)" if distribution else ""))
    for line in wrong:
        print(f"::error::{line}")
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(main())
