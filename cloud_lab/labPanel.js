// Minimal slider panel. Each control reads and writes a live object property.

export function buildPanel(root, sections, { onChange } = {}) {
    root.replaceChildren();
    const refreshers = [];
    for (const section of sections) {
        const details = document.createElement('details');
        details.open = section.open ?? false;
        const summary = document.createElement('summary');
        summary.textContent = section.title;
        details.append(summary);
        for (const control of section.controls) {
            const row = document.createElement('label');
            row.className = 'row';
            const name = document.createElement('span');
            name.textContent = control.label;
            const value = document.createElement('output');
            let input;
            if (control.type === 'toggle') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.addEventListener('change', () => { control.set(input.checked); onChange?.(control); });
                refreshers.push(() => { input.checked = !!control.get(); value.textContent = ''; });
            } else if (control.type === 'select') {
                input = document.createElement('select');
                for (const [optionValue, text] of control.options) input.append(new Option(text, optionValue));
                input.addEventListener('change', () => { control.set(Number(input.value)); onChange?.(control); });
                refreshers.push(() => { input.value = String(control.get()); value.textContent = ''; });
            } else {
                input = document.createElement('input');
                input.type = 'range';
                Object.assign(input, { min: control.min, max: control.max, step: control.step ?? (control.max - control.min) / 200 });
                const digits = control.digits ?? 2;
                input.addEventListener('input', () => {
                    control.set(Number(input.value));
                    value.textContent = Number(input.value).toFixed(digits);
                    onChange?.(control);
                });
                refreshers.push(() => {
                    input.value = String(control.get());
                    value.textContent = Number(control.get()).toFixed(digits);
                });
            }
            row.append(name, input, value);
            details.append(row);
        }
        root.append(details);
    }
    const refresh = () => refreshers.forEach(fn => fn());
    refresh();
    return { refresh };
}
