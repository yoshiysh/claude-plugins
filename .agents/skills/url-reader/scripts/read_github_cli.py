#!/usr/bin/env python3
"""Read GitHub pages through an authenticated gh CLI session."""
import argparse, base64, json, os, subprocess, sys
from urllib.parse import urlparse

def gh_call(gh, endpoint, raw=False):
    cmd=[gh, "api", endpoint]
    if raw: cmd += ["--header", "Accept: application/vnd.github.raw+json"]
    p=subprocess.run(cmd, text=True, capture_output=True)
    if p.returncode: raise RuntimeError((p.stderr or p.stdout).strip())
    return p.stdout

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("url"); ap.add_argument("--gh", default=os.environ.get("GH_CLI", "/opt/homebrew/bin/gh")); a=ap.parse_args()
    u=urlparse(a.url)
    if u.netloc.lower() not in {"github.com", "www.github.com"}: raise ValueError("only github.com URLs are supported")
    parts=[x for x in u.path.split("/") if x]
    if len(parts)<2: raise ValueError("expected a repository or file URL")
    owner, repo=parts[:2]; repo=repo.removesuffix(".git"); endpoint=f"repos/{owner}/{repo}"
    meta=json.loads(gh_call(a.gh, endpoint)); title=meta.get("full_name", f"{owner}/{repo}")
    if len(parts)>=5 and parts[2] in {"blob", "raw"}:
        data=json.loads(gh_call(a.gh, f"{endpoint}/contents/{'/'.join(parts[4:])}?ref={parts[3]}"))
        body=base64.b64decode(data["content"].replace("\n", "")).decode("utf-8", "replace"); title=data.get("name", title)
    else:
        try: body=gh_call(a.gh, f"{endpoint}/readme", raw=True)
        except RuntimeError: body=f"Repository: {title}\nDescription: {meta.get('description') or ''}\n"
    print(json.dumps({"status":"Extracted" if body.strip() else "Partial", "backend":"github_cli", "title":title, "source_url":a.url, "repository":meta.get("html_url", f"https://github.com/{owner}/{repo}"), "default_branch":meta.get("default_branch"), "private":meta.get("private", False), "markdown":body}, ensure_ascii=False))

if __name__ == "__main__":
    try: main()
    except Exception as e: print(json.dumps({"status":"Failed", "backend":"github_cli", "reason":str(e)}, ensure_ascii=False)); sys.exit(1)
