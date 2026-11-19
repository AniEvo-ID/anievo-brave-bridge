/*
 * AniEvo Brave Bridge — helper DOM (di-inject ke ISOLATED world).
 * JS halaman tidak bisa menyentuh/memalsukan objek ini, tapi DOM-nya sama.
 *
 * Selector yang didukung:
 *   css biasa           -> "button.primary"   (otomatis cari juga ke dalam open shadow root)
 *   @N                  -> ref dari perintah `snapshot`
 *   text=Label          -> elemen terkecil yang kelihatan dengan teks itu
 *   host >>> inner      -> tembus shadow DOM secara eksplisit
 */
(() => {
    const VERSION = "2.5.0";
    if (globalThis.__bb && globalThis.__bb.v === VERSION) return;

    const INTERACTIVE =
        'a[href],button,input,textarea,select,summary,[contenteditable=""],[contenteditable="true"],' +
        "[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem]," +
        "[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=combobox],[role=textbox]," +
        "[role=searchbox],[role=slider],[role=treeitem],[onclick],[tabindex]:not([tabindex='-1'])";

    const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

    function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
    }

    function inViewport(el) {
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    }

    // Semua elemen termasuk yang di dalam open shadow root.
    function deepEach(root, fn) {
        const walk = (node) => {
            const els = node.querySelectorAll("*");
            for (const e of els) {
                fn(e);
                if (e.shadowRoot) walk(e.shadowRoot);
            }
        };
        walk(root);
    }

    function deepQueryAll(sel, root = document) {
        const out = [...root.querySelectorAll(sel)];
        deepEach(root, (e) => {
            if (e.shadowRoot) out.push(...e.shadowRoot.querySelectorAll(sel));
        });
        return [...new Set(out)];
    }

    function byText(txt) {
        const want = norm(txt).toLowerCase();
        if (!want) return [];
        const cands = [];
        deepEach(document, (e) => {
            if (e.tagName === "SCRIPT" || e.tagName === "STYLE") return;
            const tc = norm(e.textContent || e.value || "").toLowerCase();
            const extra = norm(e.getAttribute && (e.getAttribute("aria-label") || e.getAttribute("value") || e.getAttribute("placeholder"))).toLowerCase();
            if (tc.includes(want) || extra.includes(want)) cands.push(e);
        });
        // Ambil elemen paling dalam (yang tidak punya turunan kandidat juga).
        let leaves = cands.filter((e) => !cands.some((o) => o !== e && e.contains(o)));
        leaves = leaves.filter(visible);
        const score = (e) => {
            const t = norm(e.innerText || e.value || e.getAttribute("aria-label") || "").toLowerCase();
            return t === want ? 0 : 1;
        };
        leaves.sort((a, b) => score(a) - score(b));
        // Naik ke elemen interaktif terdekat kalau ada (mis. <span> di dalam <button>).
        const out = [];
        for (const e of leaves) {
            const target = (e.closest && e.closest(INTERACTIVE)) || e;
            if (!out.includes(target)) out.push(target);
        }
        return out;
    }

    function qsa(sel) {
        sel = String(sel || "").trim();
        if (!sel) return [];
        if (/^@\d+$/.test(sel)) return deepQueryAll(`[data-bb-ref="${sel.slice(1)}"]`);
        if (sel.startsWith("text=")) return byText(sel.slice(5));
        if (sel.includes(">>>")) {
            const parts = sel.split(">>>").map((s) => s.trim());
            let roots = [document];
            for (let i = 0; i < parts.length; i++) {
                const found = [];
                for (const r of roots) found.push(...r.querySelectorAll(parts[i]));
                if (i === parts.length - 1) return found;
                roots = found.map((e) => e.shadowRoot).filter(Boolean);
            }
            return [];
        }
        const direct = [...document.querySelectorAll(sel)];
        return direct.length ? direct : deepQueryAll(sel);
    }

    function find(o) {
        let list;
        if (o.sel) list = qsa(o.sel);
        else if (o.text) list = byText(o.text);
        else throw new Error("Butuh selector atau --text.");
        if (o.sel && o.text) {
            const want = norm(o.text).toLowerCase();
            list = list.filter((e) => norm(e.innerText || e.value || "").toLowerCase().includes(want));
        }
        const el = list[Number(o.index || 0)];
        if (!el) throw new Error(`Elemen tidak ketemu: ${o.sel || ""}${o.text ? ` (text "${o.text}")` : ""}`);
        return el;
    }

    function center(el) {
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
    }

    function describe(el) {
        return { tag: el.tagName, text: cut(norm(el.innerText || el.value || el.getAttribute("aria-label") || ""), 120) };
    }

    function pointerSeq(el, x, y, withClick) {
        const hit = document.elementFromPoint(x, y);
        const target = hit && (hit === el || el.contains(hit)) ? hit : el;
        const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
        const pe = (type, extra = {}) =>
            target.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra }));
        const me = (type, extra = {}) => target.dispatchEvent(new MouseEvent(type, { ...base, ...extra }));
        pe("pointerover");
        pe("pointerenter", { bubbles: false });
        me("mouseover");
        me("mouseenter", { bubbles: false });
        pe("pointermove");
        me("mousemove");
        if (!withClick) return;
        pe("pointerdown", { button: 0, buttons: 1 });
        me("mousedown", { button: 0, buttons: 1 });
        if (el.focus) el.focus({ preventScroll: true });
        pe("pointerup", { button: 0, buttons: 0 });
        me("mouseup", { button: 0, buttons: 0 });
        el.click();
    }

    function nativeSet(el, value) {
        const proto =
            el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
                    : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, "value");
        if (d && d.set) d.set.call(el, value);
        else el.value = value;
    }

    function editableInsert(el, v, append) {
        el.focus();
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (append) range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        let ok = false;
        try {
            ok = v === "" ? document.execCommand("delete", false) : document.execCommand("insertText", false, v);
        } catch {
            ok = false;
        }
        if (!ok || (v && !norm(el.innerText).includes(norm(v)))) {
            el.textContent = append ? (el.textContent || "") + v : v;
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
        }
        return el.innerText;
    }

    function scroller() {
        const se = document.scrollingElement || document.documentElement;
        if (se.scrollHeight > se.clientHeight + 4) return se;
        let best = null;
        let bestH = 0;
        deepEach(document, (e) => {
            if (e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 100) {
                const oy = getComputedStyle(e).overflowY;
                if ((oy === "auto" || oy === "scroll") && e.clientHeight > bestH) {
                    best = e;
                    bestH = e.clientHeight;
                }
            }
        });
        return best || se;
    }

    function roleOf(el) {
        const r = el.getAttribute("role");
        if (r) return r;
        const t = el.tagName;
        if (t === "A") return "link";
        if (t === "BUTTON" || t === "SUMMARY") return "button";
        if (t === "SELECT") return "combobox";
        if (t === "TEXTAREA") return "textbox";
        if (t === "INPUT") {
            const ty = (el.type || "text").toLowerCase();
            if (["checkbox", "radio", "range", "file"].includes(ty)) return ty;
            if (["submit", "button", "reset", "image"].includes(ty)) return "button";
            return `textbox[${ty}]`;
        }
        if (el.isContentEditable) return "textbox[editable]";
        return "clickable";
    }

    function nameOf(el) {
        const al = el.getAttribute("aria-label");
        if (al) return norm(al);
        const lb = el.getAttribute("aria-labelledby");
        if (lb) {
            const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((e) => e.innerText).join(" ");
            if (norm(t)) return norm(t);
        }
        if (el.labels && el.labels[0]) return norm(el.labels[0].innerText);
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
            return norm(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
        }
        const txt = norm(el.innerText || "");
        if (txt) return txt;
        const img = el.querySelector && el.querySelector("img[alt]");
        return norm(el.getAttribute("title") || (img && img.alt) || el.value || "");
    }

    const ops = {
        exists: (o) => qsa(o.sel).length > 0,
        count: (o) => qsa(o.sel).length,

        text(o) {
            const el = o.sel ? find(o) : document.body;
            const s = (el.innerText || el.textContent || "").trim();
            const max = Number(o.max);
            return max > 0 && s.length > max ? s.slice(0, max) + `\n…[dipotong: ${s.length} char total, pakai --max 0 untuk semua]` : s;
        },

        html(o) {
            const el = o.sel ? find(o) : document.documentElement;
            const s = el.outerHTML;
            const max = Number(o.max);
            return max > 0 && s.length > max ? s.slice(0, max) + `\n<!-- dipotong: ${s.length} char total, pakai --max 0 -->` : s;
        },

        attr: (o) => {
            const el = find(o);
            return el.getAttribute(o.name);
        },

        rect(o) {
            const el = find(o);
            if (o.scroll !== false) el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight };
        },

        focus(o) {
            const el = find(o);
            el.scrollIntoView({ block: "center" });
            el.focus();
            if (o.clear) {
                if (el.isContentEditable) editableInsert(el, "", false);
                else {
                    nativeSet(el, "");
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                }
            }
            return describe(el);
        },

        click(o) {
            const el = find(o);
            const { x, y } = center(el);
            pointerSeq(el, x, y, true);
            return { ok: true, ...describe(el) };
        },

        dblclick(o) {
            const el = find(o);
            const { x, y } = center(el);
            pointerSeq(el, x, y, true);
            pointerSeq(el, x, y, true);
            el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 2, view: window }));
            return { ok: true, ...describe(el) };
        },

        rightclick(o) {
            const el = find(o);
            const { x, y } = center(el);
            const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 2, view: window };
            el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 2 }));
            el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 2 }));
            el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
            el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
            el.dispatchEvent(new MouseEvent("contextmenu", { ...base, buttons: 0 }));
            return { ok: true, ...describe(el) };
        },

        drag(o) {
            const src = find({ sel: o.from });
            const dst = find({ sel: o.to });
            const a = center(src);
            const b = center(dst);
            const pBase = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true, view: window };
            // 1) Pointer/mouse drag sequence (dnd-kit, SortableJS, custom drag handlers).
            src.dispatchEvent(new PointerEvent("pointerdown", { ...pBase, clientX: a.x, clientY: a.y, button: 0, buttons: 1 }));
            src.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, clientX: a.x, clientY: a.y, button: 0, buttons: 1, view: window }));
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            document.dispatchEvent(new PointerEvent("pointermove", { ...pBase, clientX: mx, clientY: my, buttons: 1 }));
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, composed: true, clientX: mx, clientY: my, buttons: 1, view: window }));
            dst.dispatchEvent(new PointerEvent("pointermove", { ...pBase, clientX: b.x, clientY: b.y, buttons: 1 }));
            dst.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, composed: true, clientX: b.x, clientY: b.y, buttons: 1, view: window }));
            // 2) HTML5 DragEvent + DataTransfer (native draggable="true").
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, clientX: a.x, clientY: a.y, dataTransfer: dt }));
            dst.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, clientX: b.x, clientY: b.y, dataTransfer: dt }));
            dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, clientX: b.x, clientY: b.y, dataTransfer: dt }));
            dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, composed: true, clientX: b.x, clientY: b.y, dataTransfer: dt }));
            src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, composed: true, clientX: b.x, clientY: b.y, dataTransfer: dt }));
            dst.dispatchEvent(new PointerEvent("pointerup", { ...pBase, clientX: b.x, clientY: b.y, button: 0, buttons: 0 }));
            dst.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, clientX: b.x, clientY: b.y, button: 0, buttons: 0, view: window }));
            return { ok: true, from: describe(src), to: describe(dst) };
        },

        hover(o) {
            const el = find(o);
            const { x, y } = center(el);
            pointerSeq(el, x, y, false);
            return { ok: true, ...describe(el) };
        },

        fill(o) {
            const el = find(o);
            el.scrollIntoView({ block: "center" });
            const v = String(o.value == null ? "" : o.value);
            if (el.isContentEditable) return { ok: true, value: editableInsert(el, v, !!o.append) };
            el.focus();
            nativeSet(el, o.append ? (el.value || "") + v : v);
            el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, value: el.type === "password" ? "***" : el.value };
        },

        // Ketik per karakter (keydown/input/keyup) — lebih mirip manusia untuk autocomplete/search box.
        type(o) {
            const el = find(o);
            el.scrollIntoView({ block: "center" });
            el.focus();
            const v = String(o.value == null ? "" : o.value);
            if (!o.append) {
                if (el.isContentEditable) editableInsert(el, "", false);
                else nativeSet(el, "");
            }
            for (const ch of v) {
                const k = { key: ch, bubbles: true, cancelable: true, composed: true };
                const go = el.dispatchEvent(new KeyboardEvent("keydown", k));
                el.dispatchEvent(new KeyboardEvent("keypress", k));
                if (go) {
                    if (el.isContentEditable) {
                        try {
                            document.execCommand("insertText", false, ch);
                        } catch {
                            el.textContent += ch;
                        }
                    } else {
                        nativeSet(el, (el.value || "") + ch);
                        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
                    }
                }
                el.dispatchEvent(new KeyboardEvent("keyup", k));
            }
            if (!el.isContentEditable) el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, value: el.isContentEditable ? el.innerText : el.type === "password" ? "***" : el.value };
        },

        select(o) {
            const el = find(o);
            if (el.tagName !== "SELECT") throw new Error("Elemen bukan <select>. Untuk dropdown custom pakai click.");
            const want = String(o.value);
            const opt =
                [...el.options].find((op) => op.value === want) ||
                [...el.options].find((op) => norm(op.textContent) === norm(want)) ||
                [...el.options].find((op) => norm(op.textContent).toLowerCase().includes(norm(want).toLowerCase()));
            if (!opt) throw new Error(`Opsi tidak ada: ${want}. Tersedia: ${[...el.options].map((x) => x.value || x.textContent).join(", ")}`);
            nativeSet(el, opt.value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, value: el.value, label: norm(opt.textContent) };
        },

        check(o) {
            const el = find(o);
            const state = () => (el.checked !== undefined && el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true");
            if (state() !== !!o.want) {
                const { x, y } = center(el);
                pointerSeq(el, x, y, true);
            }
            return { ok: true, checked: state() };
        },

        key(o) {
            const target = o.sel ? find(o) : document.activeElement || document.body;
            const parts = String(o.combo).split("+").map((x) => x.trim());
            const key = parts.pop();
            const ev = { key, bubbles: true, cancelable: true, composed: true };
            if (parts.some((p) => /ctrl|control/i.test(p))) ev.ctrlKey = true;
            if (parts.some((p) => /shift/i.test(p))) ev.shiftKey = true;
            if (parts.some((p) => /alt/i.test(p))) ev.altKey = true;
            if (parts.some((p) => /meta|cmd|win/i.test(p))) ev.metaKey = true;
            if (key === "Enter") ev.keyCode = ev.which = 13;
            if (key === "Escape") ev.keyCode = ev.which = 27;
            if (key === "Tab") ev.keyCode = ev.which = 9;
            const go = target.dispatchEvent(new KeyboardEvent("keydown", ev));
            target.dispatchEvent(new KeyboardEvent("keyup", ev));
            let submitted = false;
            // Enter sintetis tidak submit form secara native -> bantu requestSubmit.
            if (go && key === "Enter" && !ev.ctrlKey && target.form && target.tagName === "INPUT") {
                target.form.requestSubmit();
                submitted = true;
            }
            return { ok: true, key, target: target.tagName, submitted };
        },

        scroll(o) {
            const t = String(o.target || "bottom");
            const sc = scroller();
            const isDoc = sc === document.scrollingElement || sc === document.documentElement;
            if (t === "bottom") sc.scrollTo(0, sc.scrollHeight);
            else if (t === "top") sc.scrollTo(0, 0);
            else if (/^[+-]\d+$/.test(t)) sc.scrollBy(0, Number(t));
            else find({ sel: t }).scrollIntoView({ block: "center" });
            return { ok: true, y: isDoc ? scrollY : sc.scrollTop, height: sc.scrollHeight, container: isDoc ? "document" : sc.tagName };
        },

        // Tunggu elemen/teks muncul (atau hilang dengan gone=true). MutationObserver + interval.
        waitFor(o) {
            const t0 = Date.now();
            const timeout = Number(o.timeout || 15000);
            const check = () => {
                let hit;
                if (o.sel) hit = qsa(o.sel).some(visible);
                else hit = norm(document.body.innerText).toLowerCase().includes(norm(o.text).toLowerCase());
                return o.gone ? !hit : hit;
            };
            return new Promise((resolve) => {
                if (check()) return resolve({ found: true, waitedMs: 0 });
                let done = false;
                const finish = (found) => {
                    if (done) return;
                    done = true;
                    mo.disconnect();
                    clearInterval(iv);
                    clearTimeout(to);
                    resolve({ found, waitedMs: Date.now() - t0 });
                };
                const mo = new MutationObserver(() => check() && finish(true));
                mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
                const iv = setInterval(() => check() && finish(true), 200);
                const to = setTimeout(() => finish(false), timeout);
            });
        },

        // Daftar elemen interaktif dengan ref @N untuk dipakai command lain.
        snapshot(o) {
            const max = Number(o.max || 250);
            deepQueryAll("[data-bb-ref]").forEach((e) => e.removeAttribute("data-bb-ref"));
            const lines = [];
            let n = 0;
            let skipped = 0;
            const seen = new Set();
            const visit = (e) => {
                if (/^H[1-3]$/.test(e.tagName) && visible(e) && !o.noHeadings) {
                    const t = cut(norm(e.innerText), 100);
                    if (t) lines.push(`${"#".repeat(Number(e.tagName[1]))} ${t}`);
                    return;
                }
                if (!e.matches(INTERACTIVE) || seen.has(e)) return;
                if (e.closest("[aria-hidden=true]") || !visible(e)) return;
                if (e.disabled && !o.all) {
                    /* tetap tampil, ditandai disabled */
                }
                const offscreen = !inViewport(e);
                if (offscreen && o.viewport) return;
                if (n >= max) {
                    skipped++;
                    return;
                }
                seen.add(e);
                n++;
                e.setAttribute("data-bb-ref", String(n));
                const role = roleOf(e);
                let line = `@${n} ${role} "${cut(nameOf(e), 80)}"`;
                if (e.tagName === "A") {
                    const h = e.getAttribute("href") || "";
                    if (h && !h.startsWith("javascript")) line += ` -> ${cut(h, 80)}`;
                }
                if ((e.tagName === "INPUT" || e.tagName === "TEXTAREA") && !["checkbox", "radio", "submit", "button"].includes(e.type)) {
                    if (e.value) line += ` value="${e.type === "password" ? "***" : cut(e.value, 60)}"`;
                }
                if (e.tagName === "SELECT") line += ` value="${cut(norm(e.selectedOptions[0] ? e.selectedOptions[0].textContent : ""), 40)}"`;
                if (e.checked || e.getAttribute("aria-checked") === "true") line += " [checked]";
                if (e.getAttribute("aria-expanded") === "true") line += " [expanded]";
                if (e.getAttribute("aria-selected") === "true") line += " [selected]";
                if (e.disabled || e.getAttribute("aria-disabled") === "true") line += " [disabled]";
                if (offscreen) line += " (offscreen)";
                lines.push(line);
            };
            deepEach(document, visit);
            if (skipped) lines.push(`… +${skipped} elemen lagi (pakai --max N atau --viewport)`);
            return { url: location.href, title: document.title, count: n, lines };
        },

        links(o) {
            const max = Number(o.max || 200);
            const out = [];
            for (const a of deepQueryAll("a[href]")) {
                if (!visible(a)) continue;
                out.push({ text: cut(norm(a.innerText || a.getAttribute("aria-label") || ""), 80), href: a.href });
                if (out.length >= max) break;
            }
            return out;
        },

        forms() {
            const fields = deepQueryAll("input,textarea,select").filter((e) => e.type !== "hidden");
            return fields.map((e) => ({
                form: e.form ? e.form.getAttribute("id") || e.form.getAttribute("name") || e.form.getAttribute("action") || "(form)" : null,
                tag: e.tagName.toLowerCase(),
                type: e.type,
                name: e.name || null,
                id: e.id || null,
                label: cut(nameOf(e), 60),
                value: e.type === "password" ? (e.value ? "***" : "") : e.type === "checkbox" || e.type === "radio" ? e.checked : cut(String(e.value || ""), 60),
                visible: visible(e),
            }));
        },

        storage(o) {
            const store = o.area === "session" ? sessionStorage : localStorage;
            const act = o.action || "list";
            if (act === "get") return store.getItem(String(o.key));
            if (act === "set") {
                store.setItem(String(o.key), String(o.value ?? ""));
                return { ok: true, key: String(o.key) };
            }
            if (act === "remove") {
                store.removeItem(String(o.key));
                return { ok: true, removed: String(o.key) };
            }
            if (act === "clear") {
                store.clear();
                return { ok: true, cleared: o.area === "session" ? "sessionStorage" : "localStorage" };
            }
            const out = {};
            for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                const v = store.getItem(k) || "";
                out[k] = v.length > 500 ? v.slice(0, 500) + `…(${v.length} chars)` : v;
            }
            return { origin: location.origin, area: o.area === "session" ? "session" : "local", count: store.length, entries: out };
        },
    };

    globalThis.__bb = {
        v: VERSION,
        async run(op, o) {
            try {
                if (!ops[op]) return { __err: `op tidak dikenal: ${op}` };
                return await ops[op](o || {});
            } catch (e) {
                return { __err: String((e && e.message) || e) };
            }
        },
    };
})();
