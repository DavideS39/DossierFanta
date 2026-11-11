#!/usr/bin/env python3
"""
Esegue il setup della tabella `pairings` + RLS + indices sul progetto Supabase
DossierFanta usando la service_role key fornita dall'utente.

NOTA: La service_role key bypassa RLS e può eseguire DDL. Va usata SOLO per
setup una-tantum. L'utente la cancellerà dopo.

API endpoint usato: POST https://<project>.supabase.co/rest/v1/rpc/
                     (ma per DDL serve /pg endpoint o POSTGRES diretto)

In realtà Supabase non espone un endpoint pubblico per DDL via REST.
La via più affidabile è:
  1. Provare POST /rest/v1/rpc/<function> — non applicabile qui
  2. Usare psql diretto (richiede connection string)
  3. Generare uno script SQL pronto da incollare nel SQL Editor

Per il test, facciamo prima un check di connettività + permessi via API REST,
poi generiamo lo script SQL pronto (l'utente lo incolla nel SQL Editor).
"""
import sys
import json
import urllib.request
import urllib.error

# Credenziali dal syncConfig.ts (URL + anon key pubbliche)
SUPABASE_URL = "https://liwfffxhokbvzyzhivzc.supabase.co"
ANON_KEY = "sb_publishable_BHRYkkm7KWB4eKZb1P88SQ_vUy0Q4RU"
# Service role key fornita dall'utente (sarà cancellata dopo)
SERVICE_ROLE_KEY = "sb_secret_i-UUbEDPucgUJmRlNxpKyA_IlZ0yawJ"

def api_request(method, path, headers=None, body=None, expect_json=True):
    """Esegue una richiesta HTTP verso Supabase REST API."""
    url = f"{SUPABASE_URL}{path}"
    req = urllib.request.Request(url, method=method, data=body)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    req.add_header("User-Agent", "DossierFanta-setup/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status = r.status
            raw = r.read().decode("utf-8")
            if expect_json and raw:
                return status, json.loads(raw)
            return status, raw
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        return e.code, body_text
    except Exception as e:
        return 0, str(e)


def test_anon_select_pairings():
    """Test: SELECT * FROM pairings con anon key (deve fallire con 42P01 se tabella non esiste)."""
    print("\n=== Test 1: SELECT pairings con ANON key ===")
    status, body = api_request(
        "GET",
        "/rest/v1/pairings?select=*&limit=1",
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
        },
    )
    print(f"Status: {status}")
    if isinstance(body, dict):
        print(f"Body: {json.dumps(body, indent=2)[:500]}")
    else:
        print(f"Body: {body[:500]}")
    return status


def test_service_role_select_pairings():
    """Test: SELECT pairings con service_role key (deve fallire con 42P01 se tabella non esiste, oppure 200 con [] se esiste)."""
    print("\n=== Test 2: SELECT pairings con SERVICE_ROLE key ===")
    status, body = api_request(
        "GET",
        "/rest/v1/pairings?select=*&limit=1",
        headers={
            "apikey": SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        },
    )
    print(f"Status: {status}")
    if isinstance(body, list):
        print(f"Body (JSON array): {body}")
    elif isinstance(body, dict):
        print(f"Body: {json.dumps(body, indent=2)[:500]}")
    else:
        print(f"Body: {body[:500]}")
    return status


def test_service_role_create_table():
    """Tenta di creare la tabella via REST RPC.
    
    NOTA: Supabase REST API non espone un endpoint per DDL diretto.
    La via canonica è:
      - SQL Editor (manuale)
      - psql connection
      - Edge Functions con service_role + sql exec
    
    Proviamo comunque con un RPC custom (fallirà con 404 se non c'è).
    """
    print("\n=== Test 3: tentativo DDL via RPC (probabile fallimento) ===")
    ddl_sql = """
CREATE TABLE IF NOT EXISTS pairings (
  code            TEXT PRIMARY KEY,
  peer_key_initiator TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pairings_created_at ON pairings(created_at);
ALTER TABLE pairings ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS anon_pairings_all ON pairings
  FOR ALL TO anon USING (true) WITH CHECK (true);
""".strip()
    # Prova RPC hypothetico
    status, body = api_request(
        "POST",
        "/rest/v1/rpc/exec_sql",
        headers={
            "apikey": SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
        },
        body=json.dumps({"query": ddl_sql}).encode("utf-8"),
    )
    print(f"Status: {status}")
    if isinstance(body, dict):
        print(f"Body: {json.dumps(body, indent=2)[:500]}")
    else:
        print(f"Body: {body[:500]}")


if __name__ == "__main__":
    print(f"Supabase URL: {SUPABASE_URL}")
    print(f"Anon key: {ANON_KEY[:30]}...")
    print(f"Service role key: {SERVICE_ROLE_KEY[:30]}...")
    
    test_anon_select_pairings()
    test_service_role_select_pairings()
    test_service_role_create_table()
