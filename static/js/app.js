/* ============================================================
   ClinixRAG — frontend controller
   Chat, markdown, sources, library, uploads, theme, toasts
   ============================================================ */
(() => {
    "use strict";

    const $ = (selector, scope = document) => scope.querySelector(selector);
    const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

    const els = {
        html: document.documentElement,
        sidebar: $("#sidebar"),
        scrim: $("#sidebarScrim"),
        menuBtn: $("#menuBtn"),
        sidebarClose: $("#sidebarClose"),
        newChat: $("#newChat"),
        clearChat: $("#clearChat"),
        themeToggle: $("#themeToggle"),
        statusChip: $("#statusChip"),
        setupStatus: $("#setupStatus"),
        docList: $("#docList"),
        docCount: $("#docCount"),
        dropzone: $("#dropzone"),
        fileInput: $("#fileInput"),
        uploadQueue: $("#uploadQueue"),
        welcome: $("#welcome"),
        messages: $("#messages"),
        viewport: $("#chatViewport"),
        composer: $("#composer"),
        input: $("#messageInput"),
        sendButton: $("#sendButton"),
        toasts: $("#toasts"),
    };

    const MAX_UPLOAD_MB = Number(els.dropzone?.dataset.maxUpload || 40);
    const ACCEPTED = new Set(["pdf", "docx", "txt", "md", "epub", "rtf"]);
    const state = {
        sending: false,
        documents: [],
        uploadChain: Promise.resolve(),
        uploadsInFlight: 0,
    };

    /* ------------------------------------------------------------
       Utilities
       ------------------------------------------------------------ */
    const escapeHtml = (value) =>
        String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

    const icon = (name, className = "icon") =>
        `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

    const formatTime = () =>
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    function formatDate(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    }

    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function truncate(value, max) {
        const text = String(value ?? "");
        return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    /* ------------------------------------------------------------
       Markdown (safe, dependency-free)
       ------------------------------------------------------------ */
    function inlineMarkdown(raw) {
        let text = escapeHtml(raw);
        text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
        text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
        text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
        text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
        text = text.replace(
            /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
        );
        return text;
    }

    function parseTableRow(line) {
        return line
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((cell) => cell.trim());
    }

    function renderMarkdown(source) {
        let text = String(source ?? "").replace(/\r\n?/g, "\n");
        const codeBlocks = [];

        const stashCode = (code) => {
            const token = `\n\u0000CODE${codeBlocks.length}\u0000\n`;
            codeBlocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
            return token;
        };

        text = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, code) => stashCode(code));
        text = text.replace(/```[^\n`]*\n?([\s\S]*)$/g, (_, code) => stashCode(code));

        const lines = text.split("\n");
        const out = [];
        let paragraph = [];
        let listType = null;

        const flushParagraph = () => {
            if (!paragraph.length) return;
            out.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
            paragraph = [];
        };

        const closeList = () => {
            if (!listType) return;
            out.push(`</${listType}>`);
            listType = null;
        };

        const openList = (type, content) => {
            if (listType !== type) {
                closeList();
                out.push(`<${type}>`);
                listType = type;
            }
            out.push(`<li>${inlineMarkdown(content)}</li>`);
        };

        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
                flushParagraph();
                closeList();
                continue;
            }

            const codeToken = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
            if (codeToken) {
                flushParagraph();
                closeList();
                out.push(codeBlocks[Number(codeToken[1])] || "");
                continue;
            }

            const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
            if (heading) {
                flushParagraph();
                closeList();
                const level = heading[1].length;
                out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
                continue;
            }

            if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
                flushParagraph();
                closeList();
                out.push("<hr>");
                continue;
            }

            if (trimmed.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
                flushParagraph();
                closeList();
                const headers = parseTableRow(line);
                i += 2;
                const rows = [];
                while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
                    rows.push(parseTableRow(lines[i]));
                    i += 1;
                }
                i -= 1;
                const head = headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("");
                const body = rows
                    .map(
                        (row) =>
                            `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`
                    )
                    .join("");
                out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
                continue;
            }

            const unordered = line.match(/^\s*[-*•]\s+(.*)$/);
            if (unordered) {
                flushParagraph();
                openList("ul", unordered[1]);
                continue;
            }

            const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (ordered) {
                flushParagraph();
                openList("ol", ordered[1]);
                continue;
            }

            const quote = line.match(/^>\s?(.*)$/);
            if (quote) {
                flushParagraph();
                closeList();
                out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
                continue;
            }

            closeList();
            paragraph.push(line);
        }

        flushParagraph();
        closeList();
        return out.join("");
    }

    /* ------------------------------------------------------------
       Chat rendering
       ------------------------------------------------------------ */
    function scrollToBottom(behavior = "smooth") {
        els.viewport.scrollTo({ top: els.viewport.scrollHeight, behavior });
    }

    function hideWelcome() {
        els.welcome?.classList.add("is-hidden");
    }

    function showWelcome() {
        els.welcome?.classList.remove("is-hidden");
    }

    function createSources(sources) {
        if (!Array.isArray(sources) || !sources.length) return null;
        const wrap = document.createElement("div");
        wrap.className = "sources";
        const label = document.createElement("span");
        label.className = "sources-label";
        label.textContent = "Sources";
        wrap.append(label);

        sources.slice(0, 5).forEach((source, index) => {
            const chip = document.createElement("span");
            chip.className = "source-chip";
            chip.style.animationDelay = `${index * 45}ms`;
            chip.title = source.page ? `${source.source} · page ${source.page}` : source.source;
            chip.innerHTML = icon("book");
            const text = document.createElement("span");
            text.textContent = source.page ? `${source.source}` : source.source;
            chip.append(text);
            if (source.page) {
                const page = document.createElement("span");
                page.className = "source-page";
                page.textContent = `p.${source.page}`;
                chip.append(page);
            }
            wrap.append(chip);
        });
        return wrap;
    }

    function addMessage(role, text, options = {}) {
        hideWelcome();
        const isUser = role === "user";
        const message = document.createElement("div");
        message.className = `message ${isUser ? "user" : "bot"}`;

        const avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.innerHTML = icon(isUser ? "user" : "bot");

        const body = document.createElement("div");
        body.className = "msg-body";

        const meta = document.createElement("div");
        meta.className = "msg-meta";
        const author = document.createElement("strong");
        author.textContent = isUser ? "You" : "ClinixRAG";
        const sep = document.createElement("span");
        sep.className = "sep";
        const time = document.createElement("span");
        time.textContent = formatTime();
        meta.append(author, sep, time);

        const bubble = document.createElement("div");
        bubble.className = "bubble";
        if (options.error) bubble.classList.add("is-error");
        if (isUser) {
            bubble.textContent = text;
        } else {
            const markdown = document.createElement("div");
            markdown.className = "markdown";
            markdown.innerHTML = renderMarkdown(text);
            bubble.append(markdown);
            const sources = createSources(options.sources);
            if (sources) bubble.append(sources);
        }
        bubble.dataset.raw = String(text ?? "");

        body.append(meta, bubble);

        if (!isUser) {
            const actions = document.createElement("div");
            actions.className = "msg-actions";
            actions.innerHTML = `<button class="msg-action" type="button" data-action="copy">${icon("copy")} Copy</button>`;
            body.append(actions);
        }

        message.append(avatar, body);
        els.messages.append(message);
        scrollToBottom();
        return message;
    }

    function addTyping() {
        hideWelcome();
        const message = document.createElement("div");
        message.className = "message bot";
        message.dataset.typing = "true";
        message.innerHTML = `
            <div class="avatar">${icon("bot")}</div>
            <div class="msg-body">
                <div class="msg-meta"><strong>ClinixRAG</strong><span class="sep"></span><span>thinking…</span></div>
                <div class="typing-bubble"><span></span><span></span><span></span></div>
            </div>`;
        els.messages.append(message);
        scrollToBottom();
        return message;
    }

    /* ------------------------------------------------------------
       Chat request
       ------------------------------------------------------------ */
    async function sendMessage() {
        const message = els.input.value.trim();
        if (!message || state.sending) return;

        state.sending = true;
        els.sendButton.disabled = true;
        els.input.value = "";
        autoGrow();
        addMessage("user", message);
        const typing = addTyping();

        try {
            const response = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message }),
            });
            const data = await response.json().catch(() => ({}));
            typing.remove();

            if (!response.ok) {
                const text = data.error || "The assistant could not answer that right now.";
                addMessage("bot", text, { error: true });
                if (data.code === "configuration") {
                    toast("warn", "Setup needed", "Add your Pinecone and Mistral keys to .env, then restart the app.");
                }
                return;
            }

            addMessage("bot", data.answer || "I could not find an answer to that.", {
                sources: data.sources,
            });
        } catch (error) {
            typing.remove();
            addMessage(
                "bot",
                "I could not reach the ClinixRAG server. Check your connection and try again.",
                { error: true }
            );
            console.error(error);
        } finally {
            state.sending = false;
            els.sendButton.disabled = false;
            els.input.focus();
        }
    }

    async function copyText(text) {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (error) {
            /* fall through to legacy copy */
        }
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.append(area);
            area.select();
            const ok = document.execCommand("copy");
            area.remove();
            return ok;
        } catch (error) {
            return false;
        }
    }

    /* ------------------------------------------------------------
       Theme
       ------------------------------------------------------------ */
    function applyTheme(theme, persist = true) {
        const next = theme === "dark" ? "dark" : "light";
        els.html.dataset.theme = next;
        if (persist) {
            try {
                localStorage.setItem("clinixrag-theme", next);
            } catch (error) {
                /* storage may be unavailable */
            }
        }
        const dark = next === "dark";
        els.themeToggle.innerHTML = icon(dark ? "sun" : "moon");
        els.themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", dark ? "#050a12" : "#0e9f8e");
    }

    function initTheme() {
        let stored = null;
        try {
            stored = localStorage.getItem("clinixrag-theme");
        } catch (error) {
            /* ignore */
        }
        const preferred = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        applyTheme(stored || preferred, false);
    }

    /* ------------------------------------------------------------
       Sidebar (mobile)
       ------------------------------------------------------------ */
    function setSidebar(open) {
        els.sidebar.classList.toggle("is-open", open);
        els.scrim.hidden = !open;
        els.menuBtn.setAttribute("aria-expanded", String(open));
        document.body.style.overflow = open ? "hidden" : "";
    }

    /* ------------------------------------------------------------
       Status
       ------------------------------------------------------------ */
    function setStatusChip(kind, label, title) {
        els.statusChip.classList.remove("is-ready", "is-warning");
        if (kind) els.statusChip.classList.add(kind);
        $(".status-label", els.statusChip).textContent = label;
        els.statusChip.title = title || label;
    }

    function setSetupStatus(kind, text) {
        els.setupStatus.classList.remove("is-ready", "is-warning");
        if (kind) els.setupStatus.classList.add(kind);
        $("span:last-child", els.setupStatus).textContent = text;
    }

    async function loadStatus() {
        try {
            const response = await fetch("/api/status");
            if (!response.ok) throw new Error("status failed");
            const data = await response.json();
            const config = data.configuration || {};
            if (data.configured) {
                setStatusChip(
                    "is-ready",
                    "Ready",
                    `Connected to ${config.index || "Pinecone"} · ${config.model || "Mistral"}`
                );
                setSetupStatus(
                    "is-ready",
                    `${config.model || "Mistral"} · ${data.documents ?? 0} book${data.documents === 1 ? "" : "s"} indexed`
                );
            } else {
                const missing = [];
                if (!config.pinecone) missing.push("Pinecone");
                if (!config.mistral) missing.push("Mistral");
                setStatusChip(
                    "is-warning",
                    "Setup",
                    `Missing ${missing.join(" + ")} API key${missing.length === 1 ? "" : "s"}. Add them to .env.`
                );
                setSetupStatus("is-warning", `Add ${missing.join(" + ")} key to .env`);
            }
        } catch (error) {
            setStatusChip("is-warning", "Offline", "Could not reach the ClinixRAG server.");
            setSetupStatus("is-warning", "Server unavailable");
        }
    }

    /* ------------------------------------------------------------
       Document library
       ------------------------------------------------------------ */
    function renderDocuments() {
        els.docCount.textContent = String(state.documents.length);
        els.docList.innerHTML = "";

        if (!state.documents.length) {
            const empty = document.createElement("div");
            empty.className = "doc-empty";
            empty.textContent =
                "No books yet. Upload a medical reference and ClinixRAG will answer from it.";
            els.docList.append(empty);
            return;
        }

        state.documents.forEach((doc) => {
            const item = document.createElement("div");
            item.className = "doc-item";
            item.dataset.id = doc.id;

            const iconWrap = document.createElement("span");
            iconWrap.className = "doc-icon";
            iconWrap.innerHTML = icon("file");

            const info = document.createElement("span");
            info.className = "doc-info";
            const name = document.createElement("span");
            name.className = "doc-name";
            name.textContent = doc.filename || "Untitled book";
            name.title = doc.filename || "";
            const meta = document.createElement("span");
            meta.className = "doc-meta";
            const bits = [];
            if (doc.chunks) bits.push(`${doc.chunks} chunks`);
            if (doc.size) bits.push(formatSize(doc.size));
            if (doc.uploaded_at) bits.push(formatDate(doc.uploaded_at));
            meta.textContent = bits.join(" · ");
            info.append(name, meta);

            const remove = document.createElement("button");
            remove.className = "doc-delete";
            remove.type = "button";
            remove.title = "Remove from library";
            remove.setAttribute("aria-label", `Remove ${doc.filename || "book"} from library`);
            remove.innerHTML = icon("trash");

            let armed = false;
            let timer = null;
            remove.addEventListener("click", async (event) => {
                event.stopPropagation();
                if (!armed) {
                    armed = true;
                    item.classList.add("is-confirm");
                    remove.textContent = "Remove?";
                    timer = window.setTimeout(() => {
                        armed = false;
                        item.classList.remove("is-confirm");
                        remove.innerHTML = icon("trash");
                    }, 3200);
                    return;
                }
                window.clearTimeout(timer);
                remove.disabled = true;
                remove.textContent = "…";
                try {
                    const response = await fetch(`/api/documents/${encodeURIComponent(doc.id)}`, {
                        method: "DELETE",
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(data.error || "Could not remove this book.");
                    state.documents = state.documents.filter((entry) => entry.id !== doc.id);
                    renderDocuments();
                    toast("success", "Book removed", doc.filename || "Removed from the library.");
                    if (data.vectors_removed === false) {
                        toast(
                            "warn",
                            "Cleanup incomplete",
                            "The book left your library, but some stored vectors may remain in Pinecone."
                        );
                    }
                    loadStatus();
                } catch (error) {
                    remove.disabled = false;
                    remove.textContent = "Retry";
                    toast("error", "Could not remove book", error.message);
                }
            });

            item.append(iconWrap, info, remove);
            els.docList.append(item);
        });
    }

    async function loadDocuments() {
        try {
            const response = await fetch("/api/documents");
            if (!response.ok) throw new Error("Could not load library");
            const data = await response.json();
            state.documents = Array.isArray(data.documents) ? data.documents : [];
            renderDocuments();
        } catch (error) {
            els.docList.innerHTML =
                '<div class="doc-empty">Could not load the library. Is the server running?</div>';
        }
    }

    /* ------------------------------------------------------------
       Toasts
       ------------------------------------------------------------ */
    function toast(type, title, message, timeout = 5200) {
        const map = {
            success: { icon: "check", cls: "" },
            error: { icon: "alert", cls: "is-error" },
            warn: { icon: "alert", cls: "is-warn" },
            info: { icon: "info", cls: "" },
        };
        const config = map[type] || map.info;
        const el = document.createElement("div");
        el.className = `toast ${config.cls}`;
        el.innerHTML = `
            <span class="toast-icon">${icon(config.icon)}</span>
            <span class="toast-body"><strong></strong><span></span></span>
            <button class="toast-close" type="button" aria-label="Dismiss">${icon("x")}</button>`;
        $("strong", el).textContent = title;
        $(".toast-body > span", el).textContent = message || "";
        els.toasts.append(el);

        const dismiss = () => {
            if (!el.isConnected) return;
            el.classList.add("is-leaving");
            window.setTimeout(() => el.remove(), 240);
        };
        $(".toast-close", el).addEventListener("click", dismiss);
        if (timeout) window.setTimeout(dismiss, timeout);
    }

    /* ------------------------------------------------------------
       Uploads
       ------------------------------------------------------------ */
    function createUploadItem(filename) {
        const item = document.createElement("div");
        item.className = "upload-item";
        item.innerHTML = `
            <div class="upload-top">
                ${icon("file")}
                <strong></strong>
                <span class="upload-state">Queued</span>
            </div>
            <div class="upload-track"><span class="upload-bar"></span></div>`;
        $("strong", item).textContent = filename;
        els.uploadQueue.append(item);
        return item;
    }

    const setUploadState = (item, label) => {
        const stateEl = $(".upload-state", item);
        if (stateEl) stateEl.textContent = label;
    };

    const setUploadProgress = (item, percent) => {
        const bar = $(".upload-bar", item);
        if (bar) bar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    };

    function removeUploadItem(item, delay = 0) {
        window.setTimeout(() => {
            item.style.transition = "opacity .2s ease";
            item.style.opacity = "0";
            window.setTimeout(() => item.remove(), 220);
        }, delay);
    }

    function uploadOne(file, item) {
        return new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            const form = new FormData();
            form.append("files", file);

            xhr.open("POST", "/upload", true);

            xhr.upload.addEventListener("progress", (event) => {
                if (!event.lengthComputable) return;
                setUploadState(item, "Uploading");
                setUploadProgress(item, Math.round((event.loaded / event.total) * 78));
            });

            xhr.addEventListener("load", () => {
                let data = {};
                try {
                    data = JSON.parse(xhr.responseText);
                } catch (error) {
                    data = {};
                }
                const result = data.results?.[0];
                const ok = xhr.status >= 200 && xhr.status < 300 && result?.ok;

                if (ok) {
                    setUploadState(item, "Indexed");
                    setUploadProgress(item, 100);
                    item.classList.add("is-done");
                    toast(
                        "success",
                        "Book added to the library",
                        `${file.name} · ${result.chunks} passages indexed`
                    );
                    loadDocuments();
                    loadStatus();
                    removeUploadItem(item, 2800);
                } else {
                    item.classList.add("is-error");
                    setUploadState(item, "Failed");
                    setUploadProgress(item, 100);
                    const message =
                        result?.error || data.error || "Could not index this book.";
                    toast("error", "Upload failed", `${file.name}: ${message}`);
                    item.title = "Click to dismiss";
                    item.addEventListener(
                        "click",
                        () => removeUploadItem(item, 0),
                        { once: true }
                    );
                }
                resolve();
            });

            xhr.addEventListener("error", () => {
                item.classList.add("is-error");
                setUploadState(item, "Failed");
                toast("error", "Upload failed", "The server could not be reached.");
                resolve();
            });

            setUploadState(item, "Uploading");
            setUploadProgress(item, 2);
            xhr.send(form);
        });
    }

    function queueFiles(fileList) {
        const files = [...fileList];
        if (!files.length) return;

        files.forEach((file) => {
            const extension = file.name.split(".").pop()?.toLowerCase() || "";
            const item = createUploadItem(file.name);

            if (!ACCEPTED.has(extension)) {
                item.classList.add("is-error");
                setUploadState(item, "Unsupported");
                setUploadProgress(item, 100);
                toast("error", "Unsupported file", `${file.name} is not a supported book format.`);
                return;
            }

            if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
                item.classList.add("is-error");
                setUploadState(item, "Too large");
                setUploadProgress(item, 100);
                toast(
                    "error",
                    "File too large",
                    `${file.name} is over the ${MAX_UPLOAD_MB} MB limit.`
                );
                return;
            }

            state.uploadsInFlight += 1;
            state.uploadChain = state.uploadChain
                .then(() => uploadOne(file, item))
                .finally(() => {
                    state.uploadsInFlight -= 1;
                });
        });
    }

    /* ------------------------------------------------------------
       Chat controls
       ------------------------------------------------------------ */
    function autoGrow() {
        els.input.style.height = "auto";
        els.input.style.height = `${Math.min(els.input.scrollHeight, 168)}px`;
    }

    function clearConversation(showToast = false) {
        els.messages.innerHTML = "";
        showWelcome();
        els.input.value = "";
        autoGrow();
        els.input.focus();
        if (showToast) toast("info", "New consultation", "The conversation has been cleared.");
    }

    /* ------------------------------------------------------------
       Event wiring
       ------------------------------------------------------------ */
    els.composer.addEventListener("submit", (event) => {
        event.preventDefault();
        sendMessage();
    });

    els.input.addEventListener("input", autoGrow);
    els.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            sendMessage();
        }
    });

    els.messages.addEventListener("click", async (event) => {
        const button = event.target.closest('[data-action="copy"]');
        if (!button) return;
        const message = button.closest(".message");
        const bubble = $(".bubble", message);
        const text = bubble?.dataset.raw || bubble?.innerText || "";
        const ok = await copyText(text);
        if (ok) {
            button.innerHTML = `${icon("check")} Copied`;
            toast("success", "Copied", "Answer copied to your clipboard.", 2200);
            window.setTimeout(() => {
                button.innerHTML = `${icon("copy")} Copy`;
            }, 1800);
        } else {
            toast("error", "Copy failed", "Your browser blocked clipboard access.");
        }
    });

    $$(".suggestion").forEach((button) => {
        button.addEventListener("click", () => {
            els.input.value = button.dataset.prompt || "";
            autoGrow();
            setSidebar(false);
            sendMessage();
        });
    });

    els.newChat.addEventListener("click", () => {
        setSidebar(false);
        clearConversation(Boolean(els.messages.children.length));
    });

    els.clearChat.addEventListener("click", () => clearConversation(Boolean(els.messages.children.length)));

    els.themeToggle.addEventListener("click", () => {
        applyTheme(els.html.dataset.theme === "dark" ? "light" : "dark");
    });

    els.menuBtn.addEventListener("click", () => {
        setSidebar(!els.sidebar.classList.contains("is-open"));
    });
    els.sidebarClose.addEventListener("click", () => setSidebar(false));
    els.scrim.addEventListener("click", () => setSidebar(false));

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") setSidebar(false);
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            setSidebar(false);
            clearConversation(false);
            els.input.focus();
        }
    });

    els.dropzone.addEventListener("click", () => els.fileInput.click());
    els.dropzone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            els.fileInput.click();
        }
    });

    els.fileInput.addEventListener("change", () => {
        queueFiles(els.fileInput.files);
        els.fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach((name) => {
        els.dropzone.addEventListener(name, (event) => {
            event.preventDefault();
            els.dropzone.classList.add("is-dragging");
        });
    });
    ["dragleave", "dragend"].forEach((name) => {
        els.dropzone.addEventListener(name, () => els.dropzone.classList.remove("is-dragging"));
    });
    els.dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        els.dropzone.classList.remove("is-dragging");
        if (event.dataTransfer?.files?.length) queueFiles(event.dataTransfer.files);
    });
    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());

    window.addEventListener("resize", () => {
        if (window.innerWidth > 1080) setSidebar(false);
    });

    window.addEventListener("online", () => {
        toast("success", "Back online", "Reconnecting to ClinixRAG.", 2600);
        loadStatus();
    });
    window.addEventListener("offline", () => {
        toast("warn", "You are offline", "Answers and uploads need a connection.", 3600);
    });

    /* ------------------------------------------------------------
       Boot
       ------------------------------------------------------------ */
    initTheme();
    setSidebar(false);
    autoGrow();
    loadStatus();
    loadDocuments();
})();
