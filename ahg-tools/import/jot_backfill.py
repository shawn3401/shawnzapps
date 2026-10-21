#!/usr/bin/env python3
"""Load every existing submission of a jot into the Anderson Hicks Group project, once.

    python3 -I ahg-tools/import/jot_backfill.py 210986480612155

After this, Edge Function jot-sync keeps it current. Safe to rerun: jot_ingest() only adds a
version when a submission's answers changed. Also refreshes the form's question list
(jot_questions). Reads the Jotform key and the database password from ahg-tools/private/
(gitignored). Prints counts only, never client data.
"""
import json, os, subprocess, sys, tempfile, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PRIVATE = os.path.join(HERE, "..", "private")
PSQL = "/opt/homebrew/opt/libpq/bin/psql"
CONN = "host=aws-0-us-west-1.pooler.supabase.com port=5432 user=postgres.pjfiyfljkzcvfvcrdrcj dbname=postgres sslmode=require"


def secret(*names):
    for n in names:
        p = os.path.join(PRIVATE, n)
        if os.path.exists(p):
            raw = open(p, "rb").read()
            if raw.startswith(b"{\\rtf"):   # saved from TextEdit as rich text
                raw = subprocess.run(["textutil", "-format", "rtf", "-convert", "txt", "-stdout", p],
                                     check=True, capture_output=True).stdout
            return raw.decode().strip()
    sys.exit(f"Missing {names[0]} in ahg-tools/private/")


def jot(path, key, **params):
    params["apiKey"] = key
    with urllib.request.urlopen(f"https://api.jotform.com{path}?{urllib.parse.urlencode(params)}", timeout=120) as r:
        d = json.load(r)
    if d.get("responseCode") != 200:
        sys.exit(f"Jotform {d.get('responseCode')}: {d.get('message')}")
    return d["content"]


def empty(v):
    if v is None or v == "" or v == [] or v == {}:
        return True
    if isinstance(v, dict):
        return not any(x not in ("", None) for x in v.values())
    return False


def slim(s):   # same as slim() in supabase/ahg/functions/jot-sync/index.ts
    answers = {q: a["answer"] for q, a in (s.get("answers") or {}).items() if "answer" in a and not empty(a["answer"])}
    return {"id": s["id"], "created_at": s["created_at"], "updated_at": s.get("updated_at"), "status": s["status"], "answers": answers}


def psql(sql, env):
    r = subprocess.run([PSQL, CONN, "-At", "-v", "ON_ERROR_STOP=1", "-f", sql], env=env, capture_output=True, text=True)
    if r.returncode:
        sys.exit("Database error:\n" + r.stderr[-1500:])
    return r.stdout.strip()


def q(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    form = sys.argv[1] if len(sys.argv) > 1 else "210986480612155"
    key = secret("jotform-key.txt", ".jotkey")
    env = dict(os.environ, PGPASSWORD=secret("dbpass.txt"), PGCLIENTENCODING="UTF8")
    tmp = tempfile.mkdtemp(prefix="ahg-jot-")
    try:
        questions = jot(f"/form/{form}/questions", key)
        rows = [{"qid": k, "label": v.get("text", ""), "type": v.get("type", ""), "qorder": int(v.get("order", 0) or 0)} for k, v in questions.items()]
        path = os.path.join(tmp, "q.json")
        json.dump(rows, open(path, "w"))
        sql = os.path.join(tmp, "q.sql")
        open(sql, "w").write(f"""\\set j `cat {path}`
delete from jot_questions where form_id = {q(form)};
insert into jot_questions (form_id, qid, label, type, qorder)
select {q(form)}, r->>'qid', r->>'label', r->>'type', (r->>'qorder')::int from jsonb_array_elements(:'j'::jsonb) r;
select count(*) from jot_questions where form_id = {q(form)};""")
        print("questions:", psql(sql, env).splitlines()[-1])

        total, new, changed, through, offset = 0, 0, 0, "", 0
        while True:
            page = jot(f"/form/{form}/submissions", key, limit=1000, offset=offset, orderby="created_at")
            subs = [slim(s) for s in page]
            for s in subs:
                for t in (s["created_at"], s["updated_at"]):
                    if t and t > through:
                        through = t
            for i in range(0, len(subs), 250):
                path = os.path.join(tmp, "s.json")
                json.dump(subs[i:i + 250], open(path, "w"))
                sql = os.path.join(tmp, "s.sql")
                open(sql, "w").write(f"\\set j `cat {path}`\nselect jot_ingest({q(form)}, :'j'::jsonb);")
                d = json.loads(psql(sql, env).splitlines()[-1])
                new += d["new"]; changed += d["changed"]
            total += len(subs)
            print(f"  {total} read")
            if len(page) < 1000:
                break
            offset += 1000
        sql = os.path.join(tmp, "done.sql")
        open(sql, "w").write(f"""update jot_forms set synced_through = greatest(coalesce(synced_through, ''), {q(through)}),
  last_sync_at = now(), last_sync_note = {q(f'backfill: {total} read, {new} new, {changed} changed')} where form_id = {q(form)};
select count(*) from jot_submissions where form_id = {q(form)};""")
        print(f"submissions: {total} read, {new} new, {changed} changed; stored now: {psql(sql, env).splitlines()[-1]}; through {through}")
    finally:
        subprocess.run(["rm", "-rf", tmp])


if __name__ == "__main__":
    main()
