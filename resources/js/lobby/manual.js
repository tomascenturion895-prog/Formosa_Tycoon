// Pestaña "Cómo se juega" del lobby: una sección por lugar y un <details> por guía con sus pasos. Todo con textContent.

const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
};

export function renderManual(container, sections) {
    container.replaceChildren(...sections.filter((s) => s.guides.length > 0).map((section) => {
        const block = el('section', 'manual-section');
        block.append(el('h2', 'manual-place', section.label));
        for (const guide of section.guides) {
            const details = el('details', 'manual-guide');
            const summary = el('summary');
            summary.append(el('strong', null, guide.title), el('span', 'manual-summary', guide.summary));
            const steps = el('ol', 'manual-steps');
            for (const step of guide.steps) {
                const li = el('li');
                li.append(el('h3', null, step.title), el('p', null, step.text));
                steps.append(li);
            }
            details.append(summary, steps);
            block.append(details);
        }
        return block;
    }));
}
