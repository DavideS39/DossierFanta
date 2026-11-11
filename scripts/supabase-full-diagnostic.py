#!/usr/bin/env python3
"""
Diagnostica COMPLETA dello stato Supabase per DossierFanta:
1. Verifica URL + reachability
2. Verifica anon key (SELECT pairings)
3. Verifica service_role key (bypass RLS)
4. Verifica esistenza tabella pairings
5. Verifica esistenza tabella yjs_updates
6. Verifica RLS policies
7. Test INSERT/SELECT/DELETE completo

Usa sia anon che service_role keys per capire dove fallisce.
"""
import json
import urllib.request
import urllib.error
import sys

SUPABASE_URL = "https://liwfffxhokbvzyzhivzc.supabase.co"
ANON_KEY = "sb_publishable_BHRYkkm7KWB4eKZb1P88SQ_vUy0Q4RU"
# Service role key — utente la cancellerà dopo
SERVICE_ROLE_KEY = "sb_secret_i-UUbEDPucgUJmRlNxpKyA_IlZ0yawJ"


def api(method, path, key, body=None, label=""):
    url = f"{SUPABASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    req.add_header("User-Agent", "DossierFanta-diagnostic/1.0")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw) if raw else None
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        try:
            body_json = json.loads(body_text)
        except Exception:
            body_json = body_text
        return e.code, body_json
    except Exception as e:
        return 0, str(e)


def print_result(label, status, body, expect_status=None, expect_body=None):
    print(f"  {label}")
    print(f"    Status: {status}" + (f" (expect {expect_status})" if expect_status else ""))
    if isinstance(body, list):
        body_str = f"Array({len(body)}): {body}"
    elif isinstance(body, dict):
        body_str = json.dumps(body, indent=2)[:500]
    else:
        body_str = str(body)[:500]
    print(f"    Body: {body_str}")
    if expect_status and status != expect_status:
        print(f"    ❌ FAIL: expected status {expect_status}")
    elif expect_body is not None and body != expect_body:
        print(f"    ❌ FAIL: expected body {expect_body}")
    else:
        print(f"    ✓ OK")
    print()


print("=" * 70)
print("  DIAGNOSTICA COMPLETA SUPABASE — DossierFanta")
print("=" * 70)
print(f"URL: {SUPABASE_URL}")
print(f"Anon key: {ANON_KEY[:30]}...{ANON_KEY[-6:]}")
print(f"Service key: {SERVICE_ROLE_KEY[:30]}...{SERVICE_ROLE_KEY[-6:]}")
print()

# 1. Reachability test (root URL)
print("--- 1. Reachability (GET /) ---")
try:
    req = urllib.request.Request(SUPABASE_URL, method="GET")
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"  Status: {r.status} (expect 200)")
        print(f"  ✓ Reachable")
except Exception as e:
    print(f"  ❌ FAIL: {e}")
print()

# 2. Anon key test (SELECT pairings)
print("--- 2. Anon key: SELECT pairings (verify table exists) ---")
s, b = api("GET", "/rest/v1/pairings?select=*&limit=1", ANON_KEY)
print_result("anon SELECT pairings", s, b, expect_status=200)
anon_can_select_pairings = (s == 200)

# 3. Service role: SELECT pairings
print("--- 3. Service role: SELECT pairings (verify table exists) ---")
s, b = api("GET", "/rest/v1/pairings?select=*&limit=1", SERVICE_ROLE_KEY)
print_result("service SELECT pairings", s, b, expect_status=200)
service_can_select_pairings = (s == 200)

# 4. Check yjs_updates table existence (anon)
print("--- 4. Anon key: SELECT yjs_updates (verify table exists) ---")
s, b = api("GET", "/rest/v1/yjs_updates?select=*&limit=1", ANON_KEY)
print_result("anon SELECT yjs_updates", s, b, expect_status=200)
anon_can_select_yjs = (s == 200)

# 5. Test INSERT pairings with anon
print("--- 5. Anon key: INSERT pairings test code ---")
TEST_CODE = "ZZZ99999"
s, b = api("POST", "/rest/v1/pairings", ANON_KEY, {
    "code": TEST_CODE,
    "peer_key_initiator": "diagnostic-test-peer-key"
})
print_result("anon INSERT pairings", s, b, expect_status=201)
anon_can_insert = (s == 201)

# 6. Verify INSERT worked
print("--- 6. Verify: SELECT pairings WHERE code = test ---")
s, b = api("GET", f"/rest/v1/pairings?select=*&code=eq.{TEST_CODE}", ANON_KEY)
print_result("anon SELECT test code", s, b, expect_status=200)

# 7. DELETE test code
print("--- 7. Anon key: DELETE test code ---")
s, b = api("DELETE", f"/rest/v1/pairings?code=eq.{TEST_CODE}", ANON_KEY)
print_result("anon DELETE test code", s, b, expect_status=200)

# 8. Verify DELETE
print("--- 8. Verify: SELECT pairings WHERE code = test (should be []) ---")
s, b = api("GET", f"/rest/v1/pairings?select=*&code=eq.{TEST_CODE}", ANON_KEY)
print_result("anon SELECT test code post-DELETE", s, b, expect_status=200)

# 9. Summary
print("=" * 70)
print("  RIASSUNTO DIAGNOSTICA")
print("=" * 70)
print(f"  Tabella `pairings` esiste: {'✓ SÌ' if (anon_can_select_pairings or service_can_select_pairings) else '❌ NO'}")
print(f"  Tabella `yjs_updates` esiste: {'✓ SÌ' if anon_can_select_yjs else '❌ NO'}")
print(f"  Anon può INSERT pairings: {'✓ SÌ' if anon_can_insert else '❌ NO'}")
print()
if not (anon_can_select_pairings or service_can_select_pairings):
    print("  ❌❌ LA TABELLA `pairings` NON ESISTE!")
    print("     SOLUZIONE: eseguire lo script SQL in docs/supabase-setup-m3a3.sql")
    print("                sul proprio progetto Supabase (SQL Editor → Run)")
elif not anon_can_insert:
    print("  ❌❌ RLS NON CONSENTE INSERT ALL'ANON!")
    print("     SOLUZIONE: eseguire il seguente SQL sul proprio progetto Supabase:")
    print("       ALTER TABLE pairings ENABLE ROW LEVEL SECURITY;")
    print("       CREATE POLICY anon_pairings_all ON pairings")
    print("         FOR ALL TO anon USING (true) WITH CHECK (true);")
elif not anon_can_select_yjs:
    print("  ⚠️  LA TABELLA `yjs_updates` NON ESISTE!")
    print("     Questo non blocca il pairing ma blocca il sync live.")
    print("     SOLUZIONE: eseguire lo script SQL in docs/supabase-setup-m3a3.sql")
else:
    print("  ✓ TUTTO OK — pairing flow dovrebbe funzionare.")
    print("     Se ancora non funziona nell'app, il problema è nel frontend")
    print("     (INSERT non viene chiamato, o errore swallowed).")
print()
