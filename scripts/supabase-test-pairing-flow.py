#!/usr/bin/env python3
"""
Test end-to-end del pairing flow via Supabase REST API.
Simula:
  1. Initiator: INSERT pairings { code: '12345678', peer_key_initiator: 'init-A' }
  2. Responder: SELECT pairings WHERE code = '12345678' → ottiene peer_key_initiator
  3. Responder: fa ECDH (simulato) + broadcast response (no-op qui)
  4. Initiator: dopo risposta, DELETE pairings WHERE code = '12345678'

Se tutti gli step passano, il pairing flow è funzionante end-to-end.
"""
import json
import urllib.request
import urllib.error

SUPABASE_URL = "https://liwfffxhokbvzyzhivzc.supabase.co"
ANON_KEY = "sb_publishable_BHRYkkm7KWB4eKZb1P88SQ_vUy0Q4RU"

def api(method, path, body=None):
    url = f"{SUPABASE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data)
    req.add_header("apikey", ANON_KEY)
    req.add_header("Authorization", f"Bearer {ANON_KEY}")
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


CODE = "87654321"
INITIATOR_PEER_KEY = "fake-initiator-peer-key-aaaaaaaaaaaaa"

print("=" * 60)
print("  TEST PAIRING FLOW END-TO-END (Supabase)")
print("=" * 60)

# Cleanup preventivo: DELETE eventuale codice residuo
print("\n[0] Cleanup preventivo (DELETE eventuale codice residuo)...")
s, _ = api("DELETE", f"/rest/v1/pairings?code=eq.{CODE}")
print(f"    Status: {s}")

# 1. Initiator INSERT
print("\n[1] Initiator: INSERT pairings { code, peer_key_initiator }...")
s, b = api("POST", "/rest/v1/pairings", {
    "code": CODE,
    "peer_key_initiator": INITIATOR_PEER_KEY,
})
print(f"    Status: {s} (expect 201)")
print(f"    Body: {b}")
assert s == 201, f"FAIL: INSERT fallito con status {s}"

# 2. Responder SELECT
print("\n[2] Responder: SELECT pairings WHERE code = ?...")
s, b = api("GET", f"/rest/v1/pairings?select=peer_key_initiator&code=eq.{CODE}")
print(f"    Status: {s} (expect 200)")
print(f"    Body: {b}")
assert s == 200, f"FAIL: SELECT fallito con status {s}"
assert isinstance(b, list) and len(b) == 1, f"FAIL: SELECT ha ritornato {b}"
assert b[0]["peer_key_initiator"] == INITIATOR_PEER_KEY, f"FAIL: peer_key mismatch"
print(f"    ✓ peer_key_initiator ottenuto correttamente")

# 3. (simulato) ECDH + broadcast — no API call qui

# 4. Cleanup dopo pairing completo
print("\n[3] Cleanup: DELETE pairings WHERE code = ? (dopo pairing)...")
s, b = api("DELETE", f"/rest/v1/pairings?code=eq.{CODE}")
print(f"    Status: {s} (expect 200)")
print(f"    Body: {b}")
assert s == 200, f"FAIL: DELETE fallito con status {s}"

# 5. Verify DELETE
print("\n[4] Verify: SELECT pairings WHERE code = ? (deve essere vuoto)...")
s, b = api("GET", f"/rest/v1/pairings?select=*&code=eq.{CODE}")
print(f"    Status: {s}")
print(f"    Body: {b} (expect [])")
assert s == 200 and isinstance(b, list) and len(b) == 0, f"FAIL: tabella non vuota dopo DELETE"

print("\n" + "=" * 60)
print("  ✓ TUTTI I TEST PASSATI — Pairing flow funzionante end-to-end")
print("=" * 60)
