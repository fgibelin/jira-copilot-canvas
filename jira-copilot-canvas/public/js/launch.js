// The inline "New Copilot session" panel of the work item drawer: what the session should do, where it starts, notes.
import { api } from "./api.js";
import { h, icon, selectInput, setChildren, toast } from "./dom.js";
import { linkButton } from "./parts.js";
import { state } from "./state.js";

const DESCRIPTIONS = {
    context: "Loads the work item and waits for your first instruction.",
    plan: "Asks it to investigate and propose a plan before changing anything.",
    implement: "Asks it to implement the work item right away.",
};

const NOTES_LIMIT = 2000;
let sequence = 0;

/** Mounts the form into `container`. `onClose` is called when the user cancels, presses Escape, or the session started. */
export function mountLaunch(container, { key, onClose }) {
    const id = `launch-${++sequence}`;
    let disposed = false;
    let pending = false;
    let targets = null;
    let select = null;

    const intents = h(
        "fieldset",
        { class: "launch-intents" },
        h("legend", { class: "field-label" }, "What should the session do?"),
        state.intents.map((intent, index) =>
            h(
                "label",
                { class: "choice" },
                h("input", { type: "radio", name: `${id}-intent`, value: intent.id, checked: index === 0 }),
                h("span", { class: "choice-text" }, h("span", { class: "choice-title" }, intent.label), DESCRIPTIONS[intent.id] ? h("span", { class: "choice-desc" }, DESCRIPTIONS[intent.id]) : null),
            ),
        ),
    );

    const targetSlot = h("div", { class: "field" });
    const notes = h("textarea", { class: "input", id: `${id}-notes`, rows: "3", maxlength: String(NOTES_LIMIT), placeholder: "Constraints, where to start, anything the session should know" });
    const errorLine = h("p", { class: "ed-error", role: "alert", hidden: true });
    const start = h("button", { class: "btn primary", type: "submit", disabled: true }, "Start session");

    const form = h(
        "form",
        {
            class: "launch",
            "aria-labelledby": `${id}-title`,
            onsubmit: submit,
            onkeydown: (event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                if (event.target.tagName !== "SELECT") onClose();
            },
        },
        h("h3", { class: "launch-title", id: `${id}-title` }, "New Copilot session"),
        intents,
        targetSlot,
        h("div", { class: "field" }, h("label", { class: "field-label", for: `${id}-notes` }, "Notes for the session ", h("span", { class: "muted" }, "(optional)")), notes),
        errorLine,
        h("div", { class: "launch-actions" }, start, h("button", { class: "btn ghost", type: "button", onclick: () => onClose() }, "Cancel")),
    );
    container.append(form);

    const field = (...content) => setChildren(targetSlot, h("span", { class: "field-label" }, "Start in"), ...content);

    const canStart = () => !pending && targets !== null && (!select || select.value !== "");

    function renderTargets(list, last) {
        targets = list;
        select = null;
        if (list.length === 1) {
            field(h("p", { class: "launch-target" }, h("strong", {}, list[0].label), list[0].detail ? h("span", { class: "muted" }, ` · ${list[0].detail}`) : null));
        } else {
            const hint = h("p", { class: "field-hint muted" });
            // Where a session starts is the user's call unless the answer is obvious: where the last one went, or this session's own project.
            const preferred = list.find((item) => item.id === last) ?? list.find((item) => item.kind === "same");
            select = selectInput({
                label: "Start in",
                options: [{ value: "", label: "Choose where to start…" }, ...list.map((item) => ({ value: item.id, label: item.label }))],
                value: preferred?.id ?? "",
                onchange: () => refresh(),
            });
            select.id = `${id}-target`;
            const refresh = () => {
                hint.textContent = list.find((item) => item.id === select.value)?.detail ?? "";
                start.disabled = !canStart();
            };
            refresh();
            field(select, hint);
        }
        start.disabled = !canStart();
    }

    async function loadTargets() {
        field(h("p", { class: "muted" }, "Loading destinations…"));
        try {
            const data = await api.targets();
            if (disposed) return;
            if (!data.targets.length) throw new Error("There is nowhere to start a session from here.");
            renderTargets(data.targets, data.last);
        } catch (error) {
            if (disposed) return;
            field(h("div", { class: "banner error", role: "alert" }, icon("alert", { size: 14 }), h("span", {}, `Could not list where a session can start: ${error.message}`), linkButton("Try again", () => loadTargets())));
        }
    }

    function setPending(on) {
        pending = on;
        start.disabled = !canStart();
        start.textContent = on ? "Starting…" : "Start session";
        form.setAttribute("aria-busy", String(on));
    }

    async function submit(event) {
        event.preventDefault();
        const target = select ? select.value : targets?.[0]?.id;
        if (pending || !target) return;
        errorLine.hidden = true;
        const intent = form.querySelector("input[type=radio]:checked")?.value ?? "context";
        setPending(true);
        try {
            const result = await api.openSession(key, { target, intent, notes: notes.value.trim() });
            toast(result.message || (result.navigated ? `Started “${result.name}”` : `Started “${result.name}”. Find it in your session list.`));
            if (!disposed) onClose();
        } catch (error) {
            const message = error?.message || "Could not start the session.";
            if (disposed) {
                toast(message, "error");
                return;
            }
            setPending(false);
            errorLine.textContent = message;
            errorLine.hidden = false;
        }
    }

    loadTargets();
    return {
        focus: () => form.querySelector("input[type=radio]:checked")?.focus(),
        dispose() {
            disposed = true;
            form.remove();
        },
    };
}
