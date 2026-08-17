#!/usr/bin/env python3
"""Contained Scrapling recon. Runs only inside localhost/hawaldar/scrapling:min.

Policy allow-list is enforced again here; the host already gated the start URL.
GET only. No operator Python, cookies dump, CAPTCHA, proxies, or POST.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from urllib.parse import urljoin, urlparse, urlunparse

logging.getLogger("scrapling").setLevel(logging.ERROR)
logging.getLogger("curl_cffi").setLevel(logging.ERROR)

SECRET_QUERY = re.compile(
	r"^(?:token|access_token|auth|authorization|key|api[_-]?key|password|passwd|secret|session|sid|jwt|cookie)$",
	re.I,
)
SEARCH_HOSTS = {
	"google.com",
	"www.google.com",
	"duckduckgo.com",
	"www.duckduckgo.com",
	"html.duckduckgo.com",
	"bing.com",
	"www.bing.com",
}
STORAGE_FILE = "/workspace/.scrapling/elements.db"
MAX_TEXT = 8_000
MAX_EXCERPT = 4_000
MAX_MATCHES = 40
MAX_LINKS = 80


def parse_args(argv: list[str]) -> dict:
	out: dict = {
		"action": "",
		"url": "",
		"selector": "",
		"selector_type": "css",
		"identifier": "",
		"mode": "http",
		"allowed_hosts": [],
		"insecure": False,
	}
	i = 0
	while i < len(argv):
		key = argv[i]
		nxt = argv[i + 1] if i + 1 < len(argv) else ""
		if key == "--action":
			out["action"] = str(nxt or "")
			i += 2
		elif key == "--url":
			out["url"] = str(nxt or "")
			i += 2
		elif key == "--selector":
			out["selector"] = str(nxt or "")
			i += 2
		elif key == "--selector-type":
			out["selector_type"] = str(nxt or "css").lower()
			i += 2
		elif key == "--identifier":
			out["identifier"] = str(nxt or "")
			i += 2
		elif key == "--mode":
			out["mode"] = str(nxt or "http").lower()
			i += 2
		elif key == "--allowed-hosts":
			try:
				parsed = json.loads(nxt or "[]")
				out["allowed_hosts"] = [str(item).lower() for item in parsed] if isinstance(parsed, list) else []
			except json.JSONDecodeError:
				out["allowed_hosts"] = []
			i += 2
		elif key == "--insecure":
			out["insecure"] = True
			i += 1
		else:
			i += 1
	return out


def host_of(raw: str) -> str:
	try:
		return urlparse(raw).hostname.lower() if urlparse(raw).hostname else ""
	except Exception:
		return ""


def host_allowed(raw: str, allowed: list[str], search_hop: bool = False) -> bool:
	try:
		parsed = urlparse(raw)
	except Exception:
		return False
	if parsed.scheme not in ("http", "https"):
		return False
	host = (parsed.hostname or "").lower()
	if not host:
		return False
	if search_hop and host in SEARCH_HOSTS:
		return True
	return any(host == rule or host.endswith(f".{rule}") for rule in allowed)


def redact_url(raw: str) -> str:
	try:
		parsed = urlparse(raw)
		query = ""
		if parsed.query:
			from urllib.parse import parse_qsl, urlencode

			pairs = []
			for key, value in parse_qsl(parsed.query, keep_blank_values=True):
				pairs.append((key, "REDACTED" if SECRET_QUERY.match(key) else value))
			query = urlencode(pairs)
		host = parsed.hostname or ""
		if parsed.port:
			host = f"{host}:{parsed.port}"
		return urlunparse(parsed._replace(netloc=host, query=query))
	except Exception:
		return raw[:240]


def fail(reason: str, extra: dict | None = None) -> dict:
	body = {"ok": False, "error": reason}
	if extra:
		body.update(extra)
	return body


def clean_text(value: str) -> str:
	return re.sub(r"\s+", " ", str(value or "")).strip()


def ensure_storage() -> None:
	os.makedirs(os.path.dirname(STORAGE_FILE), exist_ok=True)


def fetch_page(job: dict):
	try:
		from scrapling.fetchers import Fetcher
	except ModuleNotFoundError as error:
		# scrapling imports playwright/browserforge eagerly (engines/toolbelt/*) even
		# for the curl_cffi Fetcher; the image ships those Python packages only.
		missing = getattr(error, "name", "") or str(error)
		raise RuntimeError(
			f"scrapling dependency '{missing}' missing from the image; "
			"rebuild localhost/hawaldar/scrapling:min from resources/containers/scrapling."
		) from error

	ensure_storage()
	Fetcher.configure(
		adaptive=True,
		storage_args={"storage_file": STORAGE_FILE, "url": job["url"]},
	)
	kwargs = {
		"impersonate": "chrome",
		"stealthy_headers": job["mode"] == "stealth",
		"timeout": 25,
		"max_redirects": 5,
		"verify": not job["insecure"],
	}
	if not job["url"].lower().startswith("https://"):
		# Cleartext HTTP: chrome impersonation otherwise attempts an h2c upgrade
		# that Node/Express-style targets answer by killing the socket (curl 52
		# "Empty reply"). Pin HTTP/1.1; the chrome header profile still applies.
		from curl_cffi.const import CurlHttpVersion

		kwargs["http_version"] = CurlHttpVersion.V1_1
	return Fetcher.get(job["url"], **kwargs)


def page_title(page) -> str:
	try:
		got = page.css("title::text").get()
		if got:
			return clean_text(str(got))[:240]
	except Exception:
		pass
	return ""


def page_excerpt(page) -> str:
	try:
		parts = page.css("body ::text").getall()
		text = clean_text(" ".join(str(part) for part in parts or []))
		return text[:MAX_EXCERPT]
	except Exception:
		return ""


def page_text(page) -> str:
	try:
		parts = page.css("body ::text").getall()
		text = clean_text(" ".join(str(part) for part in parts or []))
		return text[:MAX_TEXT]
	except Exception:
		return ""


def as_items(result) -> list:
	if result is None:
		return []
	if isinstance(result, (str, bytes)):
		return [result]
	try:
		return list(result)
	except TypeError:
		return [result]


def describe_item(item, base: str) -> dict:
	if isinstance(item, (str, bytes)):
		return {"text": clean_text(item.decode() if isinstance(item, bytes) else item)[:500]}
	text = ""
	try:
		text = clean_text(str(getattr(item, "text", "") or ""))
	except Exception:
		text = clean_text(str(item))[:500]
	href = ""
	tag = ""
	try:
		attrib = getattr(item, "attrib", None) or {}
		href = str(attrib.get("href") or attrib.get("src") or "")
	except Exception:
		href = ""
	try:
		tag = str(getattr(item, "tag", "") or "")
	except Exception:
		tag = ""
	abs_href = ""
	if href and not href.lower().startswith(("javascript:", "data:", "mailto:", "tel:")):
		try:
			abs_href = urljoin(base, href)
		except Exception:
			abs_href = href
	out = {"tag": tag, "text": text[:500]}
	if abs_href:
		out["href"] = redact_url(abs_href)
	return out


def select_elements(page, selector: str, selector_type: str, adaptive: bool = False, auto_save: bool = False, identifier: str = ""):
	kwargs = {"auto_save": auto_save, "adaptive": adaptive}
	if identifier:
		kwargs["identifier"] = identifier
	if selector_type == "xpath":
		return as_items(page.xpath(selector, **kwargs))
	return as_items(page.css(selector, **kwargs))


def collect_links(page, job: dict) -> list[dict]:
	items = as_items(page.css("a"))
	origin = urlparse(getattr(page, "url", job["url"])).netloc.lower()
	out: list[dict] = []
	seen: set[str] = set()
	for item in items:
		row = describe_item(item, getattr(page, "url", job["url"]))
		href = row.get("href") or ""
		if not href or href in seen:
			continue
		if not host_allowed(href, job["allowed_hosts"], False):
			continue
		seen.add(href)
		same_origin = host_of(href) == origin
		out.append({
			"title": row.get("text") or host_of(href),
			"url": href,
			"sameOrigin": same_origin,
		})
		if len(out) >= MAX_LINKS:
			break
	return out


def history_urls(page) -> list[str]:
	urls: list[str] = []
	history = getattr(page, "history", None) or []
	for item in history:
		href = getattr(item, "url", None) or (item if isinstance(item, str) else "")
		if href:
			urls.append(str(href))
	return urls


def run(job: dict) -> dict:
	action = job["action"]
	if action not in {"fetch", "text", "links", "select", "adaptive"}:
		return fail(f"Unknown action: {action}")
	if not job["url"]:
		return fail("URL is required.")
	if not job["allowed_hosts"]:
		return fail("Allow-list is empty.")
	if not host_allowed(job["url"], job["allowed_hosts"], False):
		return fail(f"Navigation refused: {redact_url(job['url'])} is not on the allow-list.")
	if action in {"select", "adaptive"} and not job["selector"]:
		return fail("selector is required.")
	if job["selector_type"] not in {"css", "xpath"}:
		return fail("selector-type must be css or xpath.")
	if job["mode"] not in {"http", "stealth"}:
		return fail("mode must be http or stealth.")

	try:
		page = fetch_page(job)
	except Exception as error:
		return fail(str(error))

	final = str(getattr(page, "url", job["url"]) or job["url"])
	if not host_allowed(final, job["allowed_hosts"], False):
		return fail(f"Redirect refused: {redact_url(final)} is not on the allow-list.", {"url": redact_url(final)})
	for href in history_urls(page):
		if not host_allowed(href, job["allowed_hosts"], False):
			return fail(f"Redirect refused: {redact_url(href)} is not on the allow-list.", {"url": redact_url(href)})

	status = int(getattr(page, "status", 0) or 0)
	title = page_title(page)
	base = {
		"ok": True,
		"action": action,
		"title": title,
		"url": redact_url(final),
		"status": status,
		"mode": job["mode"],
	}

	if action == "fetch":
		return {**base, "excerpt": page_excerpt(page)}
	if action == "text":
		return {**base, "text": page_text(page)}
	if action == "links":
		return {**base, "links": collect_links(page, job)}

	identifier = job["identifier"] or job["selector"]
	used_adaptive = False
	saved = False
	matches = select_elements(
		page,
		job["selector"],
		job["selector_type"],
		adaptive=False,
		auto_save=action == "adaptive",
		identifier=identifier,
	)
	if action == "adaptive":
		saved = bool(matches)
		if not matches:
			matches = select_elements(
				page,
				job["selector"],
				job["selector_type"],
				adaptive=True,
				auto_save=False,
				identifier=identifier,
			)
			used_adaptive = True
	described = [describe_item(item, final) for item in matches[:MAX_MATCHES]]
	body = {
		**base,
		"selector": job["selector"],
		"selectorType": job["selector_type"],
		"count": len(described),
		"matches": described,
	}
	if action == "adaptive":
		body["identifier"] = identifier
		body["usedAdaptive"] = used_adaptive
		body["saved"] = saved
	return body


def main() -> int:
	job = parse_args(sys.argv[1:])
	try:
		result = run(job)
	except Exception as error:
		result = fail(str(error))
	sys.stdout.write(f"{json.dumps(result)}\n")
	return 0 if result.get("ok") else 1


if __name__ == "__main__":
	sys.exit(main())
