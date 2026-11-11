#!/usr/bin/env python3
"""Verifica struttura + RLS della tabella pairings + prova INSERT/SELECT/DELETE."""
import json
import urllib.request
import urllib.error

SUPABASE_URL = "https://liwfffxhokbvzyzhivzc.supabase.co"
ANON_KEY = "sb_publishable_BHRYkkm7KWB4eKZb1P88SQ_vUy0Q4RU"
SERVICE_ROLE_KEY = "sb_secret_i-UUbEDPucgUJmRlNxpKyA_IlZ0yawJ"

def api(method, path, key, body=None):
    url = f"{SUPABASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")
    except Exception as e:
        return 0, str(e)


print("=== Test 1: SELECT pairings con ANON (deve ritornare []) ===")
s, b = api("GET", "/rest/v1/pairings?select=*", ANON_KEY)
print(f"Status: {s}")
print(f"Body: {b if isinstance(b, list) else (b[:300] if isinstance(b, str) else b)}")

print("\n=== Test 2: INSERT di test con ANON (verify RLS allows INSERT) ===")
test_code = "99999999"  # codice di test, sarà DELETE dopo
s, b = api("POST", "/rest/v1/pairings", ANON_KEY, {
    "code": test_code,
    "peer_key_initiator": "test-peer-key-from-z-ai-script",
})
print(f"Status: {s}")
print(f"Body: {b if isinstance(b, list) else (b[:300] if isinstance(b, str) else b)}")

print("\n=== Test 3: SELECT del test code con ANON (verify RLS allows SELECT) ===")
s, b = api("GET", f"/rest/v1/pairings?select=*&code=eq.{test_code}", ANON_KEY)
print(f"Status: {s}")
print(f"Body: {b if isinstance(b, list) else (b[:300] if isinstance(b, str) else b)}")

print("\n=== Test 4: DELETE del test code con ANON (verify RLS allows DELETE) ===")
s, b = api("DELETE", f"/rest/v1/pairings?code=eq.{test_code}", ANON_KEY)
print(f"Status: {s}")
print(f"Body (should be empty array on success): {b if isinstance(b, list) else (b[:300] if isinstance(b, str) else b)}")

print("\n=== Test 5: Verify test code è stato DELETE ===")
s, b = api("GET", f"/rest/v1/pairings?select=*&code=eq.{test_code}", ANON_KEY)
print(f"Status: {s}")
print(f"Body (should be [] after delete): {b if isinstance(b, list) else (b[:300] if isinstance(b, str) else b)}")

print("\n=== Test 6: cleanup tabella con service_role (DELETE tutti i test entries) ===")
s, b = api("DELETE", "/rest/v1/pairings?peer_key_initiator=like.test-peer-key%", SERVICE_ROLE_KEY)
print(f"Status: {s}")
print(f"Body: {b if isinstance(b, list) else (b[:300] if isinstance(b, str) else b)}")
