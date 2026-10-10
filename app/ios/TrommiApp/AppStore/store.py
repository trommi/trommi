#!/usr/bin/env python3
"""The App Store release of the iOS app: metadata, screenshots and the version for a TestFlight build, then (a separate
command) the submission for review. Standard library only, like asc.py (whose API calls it uses).

  store.py check                  offline: every text and screenshot in AppStore/metadata and AppStore/screenshots is
                                  checked against App Store Connect's limits, and what `upload` would send is printed;
                                  nothing goes to Apple
  store.py upload [BUILD]         App Store Connect gets the metadata: the app's category, name, subtitle, privacy URL,
                                  age rating, content rights, price (free) and territories (only when none are set), the
                                  version of project.yml with copyright and release type, its description, keywords,
                                  texts and URLs, App Review's contact and notes, the screenshots (a set is replaced when
                                  its files differ), and the build: BUILD (a build number) or the newest VALID build of
                                  that version. Submits nothing.
  store.py submit --yes           the version (as `upload` left it) goes to App Review. Refuses without --yes.
  store.py release --yes          a version approved with release type MANUAL goes on sale.
  store.py status                 read only: the version's state, its build, the open review submission

Environment for every command but check: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (as asc.py); BUNDLE_ID (default
com.trommi.ios). With a demo account in metadata/review_information/demo_user.txt, its password comes from
APPSTORE_DEMO_PASSWORD (never from the repository). Nothing here prints key material, tokens or that password.
What the API cannot set (App Privacy, metadata/app_privacy.json) is entered once by hand: app/ios/README.md
"App Store release".
"""
import hashlib, json, os, re, struct, sys, time, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import asc  # noqa: E402  (the JWT and the calls)

META = os.path.join(here, "metadata")
SHOTS = os.path.join(here, "screenshots")
LOCALE = "en-US"
# screenshot folder -> App Store Connect display type, the pixel sizes it takes (portrait)
DISPLAYS = {
    "iphone-6.9": ("APP_IPHONE_67", {(1320, 2868), (1290, 2796)}),
    "ipad-13": ("APP_IPAD_PRO_3GEN_129", {(2064, 2752), (2048, 2732)}),
}
# the folders App Review requires: the app runs on iPhone and iPad (project.yml TARGETED_DEVICE_FAMILY "1,2")
REQUIRED_DISPLAYS = ("iphone-6.9", "ipad-13")
CATEGORIES = {"BOOKS", "BUSINESS", "DEVELOPER_TOOLS", "EDUCATION", "ENTERTAINMENT", "FINANCE", "FOOD_AND_DRINK", "GAMES",
              "GRAPHICS_AND_DESIGN", "HEALTH_AND_FITNESS", "LIFESTYLE", "MAGAZINES_AND_NEWSPAPERS", "MEDICAL", "MUSIC",
              "NAVIGATION", "NEWS", "PHOTO_AND_VIDEO", "PRODUCTIVITY", "REFERENCE", "SHOPPING", "SOCIAL_NETWORKING",
              "SPORTS", "STICKERS", "TRAVEL", "UTILITIES", "WEATHER"}
# versions App Store Connect still lets us edit
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"}


def die(msg):
    asc.die(msg)


def text(*parts, required=True):
    path = os.path.join(META, *parts)
    if not os.path.exists(path):
        if required:
            die(f"missing {os.path.relpath(path, here)}")
        return ""
    return open(path, encoding="utf-8").read().strip()


def jsonfile(name):
    data = json.load(open(os.path.join(META, name), encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def version_string():
    m = re.search(r'^\s*MARKETING_VERSION:\s*"?([^"\s]+)"?\s*$', open(os.path.join(here, "project.yml")).read(), re.M)
    return m.group(1) if m else die("no MARKETING_VERSION in project.yml")


# ---- what is sent ---------------------------------------------------------------------------------------------------

def metadata():
    m = {
        "name": text(LOCALE, "name.txt"),
        "subtitle": text(LOCALE, "subtitle.txt"),
        "promotionalText": text(LOCALE, "promotional_text.txt"),
        "description": text(LOCALE, "description.txt"),
        "keywords": text(LOCALE, "keywords.txt"),
        "supportUrl": text(LOCALE, "support_url.txt"),
        "marketingUrl": text(LOCALE, "marketing_url.txt", required=False),
        "privacyPolicyUrl": text(LOCALE, "privacy_url.txt"),
        "copyright": text("copyright.txt"),
        "primaryCategory": text("primary_category.txt"),
        "secondaryCategory": text("secondary_category.txt", required=False),
        "releaseType": text("release_type.txt", required=False) or "MANUAL",
        "contentRights": text("content_rights.txt", required=False) or "DOES_NOT_USE_THIRD_PARTY_CONTENT",
        "ageRating": jsonfile("age_rating.json"),
        "availability": jsonfile("availability.json"),
    }
    demo_user = text("review_information", "demo_user.txt", required=False)
    m["review"] = {
        "contactFirstName": text("review_information", "first_name.txt"),
        "contactLastName": text("review_information", "last_name.txt"),
        "contactEmail": text("review_information", "email_address.txt"),
        "contactPhone": text("review_information", "phone_number.txt", required=False),
        "notes": text("review_information", "notes.txt"),
        "demoAccountRequired": bool(demo_user),
        "demoAccountName": demo_user or None,
    }
    return m


def png_info(path):
    """(width, height, has_alpha) of a PNG, from its header and chunks."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h, depth, color = struct.unpack(">IIBB", data[16:26])
    alpha = color in (4, 6) or b"tRNS" in data[:data.find(b"IDAT")]
    return w, h, alpha


def screenshots():
    """{folder: [paths in order]} of the screenshot folders of LOCALE."""
    base = os.path.join(SHOTS, LOCALE)
    out = {}
    for folder in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        files = sorted(f for f in os.listdir(os.path.join(base, folder)) if f.lower().endswith(".png"))
        out[folder] = [os.path.join(base, folder, f) for f in files]
    return out


def check():
    m, problems, notes = metadata(), [], []
    limits = {"name": 30, "subtitle": 30, "promotionalText": 170, "description": 4000, "copyright": 200}
    for key, n in limits.items():
        if not m[key]:
            problems.append(f"{key} is empty")
        if len(m[key]) > n:
            problems.append(f"{key} has {len(m[key])} characters, at most {n}")
    kw = m["keywords"]
    if len(kw.encode()) > 100:
        problems.append(f"keywords have {len(kw.encode())} bytes, at most 100")
    if any(not k.strip() for k in kw.split(",")) or ", " in kw:
        problems.append("keywords: comma-separated without spaces or empty items")
    for key in ("supportUrl", "marketingUrl", "privacyPolicyUrl"):
        if m[key] and not re.match(r"^https://[^\s]+$", m[key]):
            problems.append(f"{key} is not an https URL: {m[key]}")
    for key in ("primaryCategory", "secondaryCategory"):
        if m[key] and m[key] not in CATEGORIES:
            problems.append(f"{key} {m[key]} is not a category")
    if m["releaseType"] not in ("MANUAL", "AFTER_APPROVAL"):
        problems.append("release_type.txt: MANUAL or AFTER_APPROVAL")
    r = m["review"]
    if len(r["notes"]) > 4000:
        problems.append(f"review notes have {len(r['notes'])} characters, at most 4000")
    if not r["contactPhone"]:
        notes.append("review_information/phone_number.txt is empty: App Store Connect needs a phone number for App "
                     "Review (with the country code, e.g. +49 …) before `upload`")
    if r["demoAccountRequired"]:
        notes.append("a demo account is named: `upload` needs APPSTORE_DEMO_PASSWORD")
    shots = screenshots()
    for folder in REQUIRED_DISPLAYS:
        if not shots.get(folder):
            problems.append(f"no screenshots in screenshots/{LOCALE}/{folder}")
    for folder, files in shots.items():
        if folder not in DISPLAYS:
            problems.append(f"screenshots/{LOCALE}/{folder}: not a known display ({', '.join(DISPLAYS)})")
            continue
        if not 1 <= len(files) <= 10:
            problems.append(f"screenshots/{LOCALE}/{folder}: {len(files)} files, 1 to 10")
        for f in files:
            info = png_info(f)
            rel = os.path.relpath(f, here)
            if not info:
                problems.append(f"{rel}: not a PNG")
            elif (info[0], info[1]) not in DISPLAYS[folder][1]:
                problems.append(f"{rel}: {info[0]}x{info[1]}, wants one of {sorted(DISPLAYS[folder][1])}")
            elif info[2]:
                problems.append(f"{rel}: has an alpha channel (App Store Connect refuses it)")
    shown = dict(m)
    print(json.dumps({"version": version_string(), **shown,
                      "screenshots": {k: [os.path.basename(f) for f in v] for k, v in shots.items()}}, indent=2))
    for n in notes:
        print(f"note: {n}")
    for p in problems:
        print(f"::error::{p}")
    print("check: " + ("FAILED" if problems else "ok, nothing was sent"))
    return not problems


# ---- App Store Connect ----------------------------------------------------------------------------------------------

def call(method, path, body=None, ok=()):
    return asc.call(method, path, body, ok)


def rel(kind, ident):
    return asc.rel(kind, ident)


def the_app():
    bundle = os.environ.setdefault("BUNDLE_ID", "com.trommi.ios")
    return asc.app_id(bundle) or die(f"no App Store Connect app record for {bundle}")


def patch(kind, ident, attributes=None, relationships=None):
    """PATCH that drops an attribute App Store Connect does not know (it names it in the error) and tries again: the
    age rating questions change from year to year."""
    attributes = dict(attributes or {})
    for _ in range(len(attributes) + 1):
        body = {"data": {"type": kind, "id": ident}}
        if attributes:
            body["data"]["attributes"] = attributes
        if relationships:
            body["data"]["relationships"] = relationships
        answer = call("PATCH", f"/v1/{kind}/{ident}", body, ok=(409, 422))
        if "error" not in answer:
            return answer
        unknown = [a for a in attributes if f"'{a}'" in answer["detail"] or f"/{a}" in answer["detail"]
                   or f" {a} " in f" {answer['detail']} "]
        if not unknown:
            die(f"PATCH {kind} {ident}: {answer['detail']}")
        for a in unknown:
            print(f"::warning::App Store Connect does not take {kind}.{a}; left out ({answer['detail']})")
            attributes.pop(a)
    die(f"PATCH {kind} {ident}: nothing left to send")


def editable_app_info(aid):
    infos = call("GET", f"/v1/apps/{aid}/appInfos")["data"]
    for info in infos:
        state = info["attributes"].get("state") or info["attributes"].get("appStoreState")
        if state not in ("READY_FOR_DISTRIBUTION", "READY_FOR_SALE", "REPLACED_WITH_NEW_INFO"):
            return info["id"]
    return infos[0]["id"] if infos else die("the app has no app info")


def localization(list_path, kind, parent_kind, parent_id, attributes):
    rows = call("GET", list_path)["data"]
    found = [r for r in rows if r["attributes"].get("locale") == LOCALE]
    if found:
        patch(kind, found[0]["id"], attributes)
        return found[0]["id"]
    print(f"creating the {LOCALE} {kind}")
    parent = {"appInfos": "appInfo", "appStoreVersions": "appStoreVersion"}[parent_kind]
    return call("POST", f"/v1/{kind}", {"data": {"type": kind, "attributes": {"locale": LOCALE, **attributes},
                "relationships": {parent: rel(parent_kind, parent_id)}}})["data"]["id"]


def find_version(aid, version):
    rows = call("GET", f"/v1/apps/{aid}/appStoreVersions?filter[platform]=IOS&filter[versionString]={asc.q(version)}"
                       "&limit=5")["data"]
    return rows[0] if rows else None


def version_state(row):
    a = row["attributes"]
    return a.get("appVersionState") or a.get("appStoreState") or "?"


def pick_build(aid, version, number=None):
    path = (f"/v1/builds?filter[app]={aid}&filter[preReleaseVersion.version]={asc.q(version)}"
            f"&filter[processingState]=VALID&sort=-uploadedDate&limit=20")
    if number:
        path += f"&filter[version]={asc.q(number)}"
    rows = [b for b in call("GET", path)["data"] if not b["attributes"].get("expired")]
    if not rows:
        die(f"no VALID, unexpired build of version {version}" + (f" with build number {number}" if number else "")
            + " in App Store Connect: deliver one to TestFlight first (deploy_ios)")
    b = rows[0]
    if b["attributes"].get("usesNonExemptEncryption") is None:
        die(f"build {b['attributes']['version']} has no export compliance answer: answer it in App Store Connect "
            "(TestFlight > the build) or deliver a build with ITSAppUsesNonExemptEncryption set")
    return b["id"], b["attributes"]["version"]


def upload_screenshots(loc_id, shots):
    sets = {s["attributes"]["screenshotDisplayType"]: s["id"]
            for s in call("GET", f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets?limit=50")["data"]}
    for folder, files in shots.items():
        display = DISPLAYS[folder][0]
        set_id = sets.get(display)
        if not set_id:
            set_id = call("POST", "/v1/appScreenshotSets", {"data": {"type": "appScreenshotSets",
                          "attributes": {"screenshotDisplayType": display},
                          "relationships": {"appStoreVersionLocalization": rel("appStoreVersionLocalizations", loc_id)}}})["data"]["id"]
        wanted = [(os.path.basename(f), hashlib.md5(open(f, "rb").read()).hexdigest()) for f in files]
        have = call("GET", f"/v1/appScreenshotSets/{set_id}/appScreenshots?limit=50")["data"]
        have_keys = [(s["attributes"].get("fileName"), s["attributes"].get("sourceFileChecksum")) for s in have]
        if have_keys == wanted:
            print(f"screenshots {display}: unchanged ({len(files)})")
            continue
        for s in have:
            call("DELETE", f"/v1/appScreenshots/{s['id']}")
        ids = []
        for f, (name, md5) in zip(files, wanted):
            data = open(f, "rb").read()
            shot = call("POST", "/v1/appScreenshots", {"data": {"type": "appScreenshots",
                        "attributes": {"fileName": name, "fileSize": len(data)},
                        "relationships": {"appScreenshotSet": rel("appScreenshotSets", set_id)}}})["data"]
            for op in shot["attributes"]["uploadOperations"]:
                part = data[op["offset"]:op["offset"] + op["length"]]
                req = urllib.request.Request(op["url"], data=part, method=op["method"],
                                             headers={h["name"]: h["value"] for h in op.get("requestHeaders", [])})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    resp.read()
            patch("appScreenshots", shot["id"], {"uploaded": True, "sourceFileChecksum": md5})
            ids.append(shot["id"])
            print(f"screenshot {display} {name}: uploaded")
        for sid in ids:
            for i in range(40):
                state = (call("GET", f"/v1/appScreenshots/{sid}")["data"]["attributes"].get("assetDeliveryState") or {})
                if state.get("state") == "COMPLETE":
                    break
                if state.get("state") == "FAILED":
                    die(f"screenshot {sid} failed: {state.get('errors')}")
                time.sleep(3)
        call("PATCH", f"/v1/appScreenshotSets/{set_id}/relationships/appScreenshots",
             {"data": [{"type": "appScreenshots", "id": i} for i in ids]})
        print(f"screenshots {display}: {len(ids)} in order")


def price_and_territories(aid, availability):
    if "error" in call("GET", f"/v1/apps/{aid}/appPriceSchedule", ok=(404,)):
        if not availability.get("free", True):
            die("availability.json: only a free app is set up here")
        points = call("GET", f"/v1/apps/{aid}/appPricePoints?filter[territory]=USA&limit=200")["data"]
        free = [p for p in points if float(p["attributes"].get("customerPrice") or "1") == 0.0]
        free or die("no free price point for the USA")
        call("POST", "/v1/appPriceSchedules", {
            "data": {"type": "appPriceSchedules", "relationships": {
                "app": rel("apps", aid), "baseTerritory": rel("territories", "USA"),
                "manualPrices": {"data": [{"type": "appPrices", "id": "${free}"}]}}},
            "included": [{"type": "appPrices", "id": "${free}", "attributes": {"startDate": None},
                          "relationships": {"appPricePoint": rel("appPricePoints", free[0]["id"])}}]})
        print("price: free")
    else:
        print("price: already set (left as it is)")
    if "error" in call("GET", f"/v1/apps/{aid}/appAvailabilityV2", ok=(404,)):
        territories, path = [], "/v1/territories?limit=200"
        while path:
            page = call("GET", path)
            territories += [t["id"] for t in page["data"]]
            nxt = page.get("links", {}).get("next")
            path = nxt[len(asc.API):] if nxt else None
        excluded = set(availability.get("exclude_territories", []))
        call("POST", "/v2/appAvailabilities", {
            "data": {"type": "appAvailabilities",
                     "attributes": {"availableInNewTerritories": bool(availability.get("available_in_new_territories"))},
                     "relationships": {"app": rel("apps", aid), "territoryAvailabilities": {"data": [
                         {"type": "territoryAvailabilities", "id": f"${{{t}}}"} for t in territories]}}},
            "included": [{"type": "territoryAvailabilities", "id": f"${{{t}}}", "attributes": {"available": t not in excluded},
                          "relationships": {"territory": rel("territories", t)}} for t in territories]})
        print(f"territories: {len(territories) - len(excluded & set(territories))} of {len(territories)} "
              f"(not {', '.join(sorted(excluded)) or 'none'})")
    else:
        print("territories: already set (left as they are)")


def upload(number=None):
    if not check():
        die("the local check failed; nothing was sent")
    m = metadata()
    r = m["review"]
    if not r["contactPhone"]:
        die("review_information/phone_number.txt is empty")
    if r["demoAccountRequired"]:
        r["demoAccountPassword"] = os.environ.get("APPSTORE_DEMO_PASSWORD") or die("APPSTORE_DEMO_PASSWORD is not set")
    aid, version = the_app(), version_string()

    print("== app ==")
    patch("apps", aid, {"contentRightsDeclaration": m["contentRights"]})
    info = editable_app_info(aid)
    cats = {"primaryCategory": rel("appCategories", m["primaryCategory"])}
    if m["secondaryCategory"]:
        cats["secondaryCategory"] = rel("appCategories", m["secondaryCategory"])
    patch("appInfos", info, relationships=cats)
    localization(f"/v1/appInfos/{info}/appInfoLocalizations", "appInfoLocalizations", "appInfos", info,
                 {"name": m["name"], "subtitle": m["subtitle"], "privacyPolicyUrl": m["privacyPolicyUrl"]})
    rating = call("GET", f"/v1/appInfos/{info}/ageRatingDeclaration")["data"]
    patch("ageRatingDeclarations", rating["id"], m["ageRating"])
    price_and_territories(aid, m["availability"])

    print(f"== version {version} ==")
    row = find_version(aid, version)
    if row is None:
        row = call("POST", "/v1/appStoreVersions", {"data": {"type": "appStoreVersions", "attributes": {
            "platform": "IOS", "versionString": version, "copyright": m["copyright"], "releaseType": m["releaseType"]},
            "relationships": {"app": rel("apps", aid)}}})["data"]
        print(f"created version {version}")
    elif version_state(row) not in EDITABLE:
        die(f"version {version} is {version_state(row)}: App Store Connect does not let it be changed now")
    else:
        patch("appStoreVersions", row["id"], {"copyright": m["copyright"], "releaseType": m["releaseType"]})
    vid = row["id"]
    build_id, build_number = pick_build(aid, version, number)
    call("PATCH", f"/v1/appStoreVersions/{vid}/relationships/build", {"data": {"type": "builds", "id": build_id}})
    print(f"build: {version} ({build_number})")
    texts = {k: m[k] for k in ("description", "keywords", "promotionalText", "supportUrl", "marketingUrl") if m[k]}
    loc = localization(f"/v1/appStoreVersions/{vid}/appStoreVersionLocalizations", "appStoreVersionLocalizations",
                       "appStoreVersions", vid, texts)
    review = {k: v for k, v in r.items() if v is not None}
    detail = call("GET", f"/v1/appStoreVersions/{vid}/appStoreReviewDetail", ok=(404,))
    if detail.get("data"):
        patch("appStoreReviewDetails", detail["data"]["id"], review)
    else:
        call("POST", "/v1/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": review,
             "relationships": {"appStoreVersion": rel("appStoreVersions", vid)}}})
    print("App Review details: set")
    upload_screenshots(loc, screenshots())
    print(f"upload: version {version} ({build_number}) is ready in App Store Connect; nothing was submitted. "
          "Still by hand once: App Privacy (metadata/app_privacy.json). Then: store.py submit --yes")


def open_submission(aid):
    rows = call("GET", f"/v1/reviewSubmissions?filter[app]={aid}&filter[platform]=IOS&limit=20")["data"]
    return [s for s in rows if s["attributes"].get("state") in ("READY_FOR_REVIEW", "WAITING_FOR_REVIEW", "IN_REVIEW",
                                                                  "UNRESOLVED_ISSUES")]


def submit(*flags):
    if "--yes" not in flags:
        die("submit sends the version to App Review: run it as `store.py submit --yes`")
    aid, version = the_app(), version_string()
    row = find_version(aid, version) or die(f"no version {version}: run `store.py upload` first")
    if version_state(row) not in EDITABLE:
        die(f"version {version} is {version_state(row)}; nothing to submit")
    build = call("GET", f"/v1/appStoreVersions/{row['id']}/build", ok=(404,))
    if not build.get("data"):
        die(f"version {version} has no build: run `store.py upload` first")
    waiting = [s for s in open_submission(aid) if s["attributes"].get("state") != "READY_FOR_REVIEW"]
    if waiting:
        die(f"a review submission is already {waiting[0]['attributes']['state']}")
    ready = open_submission(aid)
    sid = ready[0]["id"] if ready else call("POST", "/v1/reviewSubmissions", {"data": {"type": "reviewSubmissions",
                                            "attributes": {"platform": "IOS"}, "relationships": {"app": rel("apps", aid)}}})["data"]["id"]
    items = call("GET", f"/v1/reviewSubmissions/{sid}/items?limit=20")["data"]
    if not items:
        call("POST", "/v1/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems", "relationships": {
            "reviewSubmission": rel("reviewSubmissions", sid), "appStoreVersion": rel("appStoreVersions", row["id"])}}})
    patch("reviewSubmissions", sid, {"submitted": True})
    print(f"submitted: version {version} ({build['data']['attributes']['version']}) is with App Review")


def release(*flags):
    if "--yes" not in flags:
        die("release puts the approved version on sale: run it as `store.py release --yes`")
    aid, version = the_app(), version_string()
    row = find_version(aid, version) or die(f"no version {version}")
    if version_state(row) != "PENDING_DEVELOPER_RELEASE":
        die(f"version {version} is {version_state(row)}, not waiting for its release")
    call("POST", "/v1/appStoreVersionReleaseRequests", {"data": {"type": "appStoreVersionReleaseRequests",
         "relationships": {"appStoreVersion": rel("appStoreVersions", row["id"])}}})
    print(f"released: version {version} goes on sale")


def status():
    aid, version = the_app(), version_string()
    row = find_version(aid, version)
    if not row:
        print(f"version {version}: not created yet")
        return
    build = call("GET", f"/v1/appStoreVersions/{row['id']}/build", ok=(404,)).get("data")
    print(f"version {version}: {version_state(row)}, build {build['attributes']['version'] if build else 'none'}")
    for s in open_submission(aid):
        print(f"review submission {s['id']}: {s['attributes'].get('state')}")


if __name__ == "__main__":
    cmds = {"check": lambda: sys.exit(0 if check() else 1), "upload": upload, "submit": submit, "release": release,
            "status": status}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])
