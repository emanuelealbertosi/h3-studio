"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_JOB_LORAS, type JobLoraOverride } from "../lib/job-loras";

export type JobLoraSelection = JobLoraOverride & { inherited?: boolean };
export type JobLoraCatalogEntry = {
  family: string;
  prefix: string;
  baseModel: string | null;
  modelName: string | null;
  versionName: string | null;
  source: "civitai" | "sidecar" | "filename" | "unknown";
};

export function selectionsFromGlobal(
  defaults: ReadonlyArray<{ name: string; strength: number }>,
): JobLoraSelection[] {
  return defaults.slice(0, MAX_JOB_LORAS).map((item) => ({
    ...item,
    enabled: true,
    inherited: true,
  }));
}

export function selectionsFromApplied(
  defaults: ReadonlyArray<{ name: string; strength: number }>,
  applied: ReadonlyArray<{ name: string; strength: number }>,
): JobLoraSelection[] {
  const appliedByName = new Map(
    applied.map((item) => [item.name.toLocaleLowerCase("en-US"), item]),
  );
  const inherited = defaults.map((item) => {
    const selected = appliedByName.get(item.name.toLocaleLowerCase("en-US"));
    return {
      name: item.name,
      strength: selected?.strength ?? item.strength,
      enabled: Boolean(selected),
      inherited: true,
    };
  });
  const globalNames = new Set(defaults.map((item) => item.name.toLocaleLowerCase("en-US")));
  return [
    ...inherited,
    ...applied.filter((item) => !globalNames.has(item.name.toLocaleLowerCase("en-US"))).map((item) => ({
      ...item,
      enabled: true,
      inherited: false,
    })),
  ];
}

export function loraOverridesPayload(value: ReadonlyArray<JobLoraSelection>) {
  return value.flatMap((item) => item.name.trim()
    ? [{ name: item.name.trim(), strength: item.strength, enabled: item.enabled }]
    : []);
}

type Props = {
  available: string[];
  catalog?: Record<string, JobLoraCatalogEntry>;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
  onChange: (value: JobLoraSelection[]) => void;
  value: JobLoraSelection[];
};

type LoraComboboxProps = {
  available: string[];
  canClear: boolean;
  catalog: Record<string, JobLoraCatalogEntry>;
  current: string;
  index: number;
  onChange: (name: string) => void;
  selectedNames: Set<string>;
};

function LoraCombobox({
  available,
  canClear,
  catalog,
  current,
  index,
  onChange,
  selectedNames,
}: LoraComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("ALL");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedSelected = useMemo(
    () => new Set([...selectedNames].map((name) => name.toLocaleLowerCase("en-US"))),
    [selectedNames],
  );
  const filtered = useMemo(() => {
    const tokens = query
      .toLocaleLowerCase("en-US")
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return available;
    return available.filter((name) => {
      const metadata = catalog[name];
      const searchable = [name, metadata?.prefix, metadata?.baseModel, metadata?.modelName]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("en-US")
        .replace(/[\\/_-]+/g, " ");
      return (family === "ALL" || metadata?.family === family)
        && tokens.every((token) => searchable.includes(token));
    });
  }, [available, catalog, family, query]);
  const families = useMemo(() => [...new Set(available.map((name) => catalog[name]?.family ?? "?"))]
    .sort((left, right) => left === "?" ? 1 : right === "?" ? -1 : left.localeCompare(right)),
  [available, catalog]);

  const filteredWithoutQuery = useMemo(() => family === "ALL"
    ? available
    : available.filter((name) => (catalog[name]?.family ?? "?") === family),
  [available, catalog, family]);

  const visible = query.trim() ? filtered : filteredWithoutQuery;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const choose = (name: string) => {
    onChange(name);
    setQuery("");
    setOpen(false);
  };

  const firstSelectable = visible.find(
    (name) => name === current || !normalizedSelected.has(name.toLocaleLowerCase("en-US")),
  );
  const currentMetadata = catalog[current];

  return (
    <div className={`job-lora-picker ${open ? "open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`LoRA ${index + 1}`}
        className="job-lora-picker-trigger"
        onClick={() => setOpen((value) => !value)}
        title={current || "Seleziona LoRA"}
        type="button"
      >
        <span>{current ? `${currentMetadata?.prefix ?? "?"} · ${current}` : "Seleziona LoRA…"}</span>
        <b aria-hidden="true">⌄</b>
      </button>
      {open && (
        <div className="job-lora-picker-menu">
          <div className="job-lora-picker-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label={`Filtra LoRA ${index + 1}`}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setOpen(false);
                if (event.key === "Enter" && firstSelectable) {
                  event.preventDefault();
                  choose(firstSelectable);
                }
              }}
              placeholder="Cerca per nome o cartella…"
              ref={inputRef}
              type="search"
              value={query}
            />
            <small>{visible.length}/{available.length}</small>
          </div>
          <div className="job-lora-family-filter">
            <button className={family === "ALL" ? "selected" : ""} onClick={() => setFamily("ALL")} type="button">Tutti</button>
            {families.map((item) => (
              <button className={family === item ? "selected" : ""} key={item} onClick={() => setFamily(item)} type="button">{item}</button>
            ))}
          </div>
          <div aria-label="LoRA disponibili" className="job-lora-picker-options" role="listbox">
            {canClear && (
              <button
                className={!current ? "selected" : ""}
                onClick={() => choose("")}
                role="option"
                type="button"
              >
                Nessun LoRA
              </button>
            )}
            {current && !available.includes(current) && (
              <button className="missing selected" onClick={() => choose(current)} role="option" type="button">
                {current}<small>Non rilevato</small>
              </button>
            )}
            {visible.map((name) => {
              const usedElsewhere = name !== current
                && normalizedSelected.has(name.toLocaleLowerCase("en-US"));
              const metadata = catalog[name];
              return (
                <button
                  className={name === current ? "selected" : ""}
                  disabled={usedElsewhere}
                  key={name}
                  onClick={() => choose(name)}
                  role="option"
                  title={name}
                  type="button"
                >
                  <span><b>{metadata?.prefix ?? "?"}</b>{name}</span>
                  {name === current && <small>Selezionato</small>}
                  {usedElsewhere && <small>Già usato</small>}
                </button>
              );
            })}
            {visible.length === 0 && (
              <p>Nessun LoRA corrisponde a “{query}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function JobLoraSelector({
  available,
  catalog = {},
  disabled = false,
  disabledReason,
  label = "LoRA per questa esecuzione",
  onChange,
  value,
}: Props) {
  const active = value.filter((item) => item.name && item.enabled).length;
  const customCount = value.filter((item) => !item.inherited).length;
  const selectedNames = new Set(value.map((item) => item.name).filter(Boolean));
  const update = (index: number, patch: Partial<JobLoraSelection>) => {
    onChange(value.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  };
  return (
    <fieldset className="job-lora-panel" disabled={disabled}>
      <legend>{label}</legend>
      <div className="job-lora-heading">
        <span>Override del solo job · i preset Engine non vengono modificati</span>
        <b>{active}/{MAX_JOB_LORAS} attivi</b>
      </div>
      {disabledReason && <p className="job-lora-warning">{disabledReason}</p>}
      <div className="job-lora-list">
        {value.map((item, index) => (
          <div className={`job-lora-row ${item.enabled ? "enabled" : "disabled"}`} key={`${item.inherited ? "global" : "job"}-${index}`}>
            <label className="job-lora-toggle" title={item.inherited ? "LoRA globale: disattivalo soltanto per questo job" : "Attiva LoRA"}>
              <input checked={item.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} type="checkbox" />
              <span>{item.inherited ? "Globale" : "Job"}</span>
            </label>
            <LoraCombobox
              available={available}
              canClear={!item.inherited}
              catalog={catalog}
              current={item.name}
              index={index}
              onChange={(name) => update(index, { name })}
              selectedNames={selectedNames}
            />
            <label className="job-lora-strength">
              <span>Peso</span>
              <input max="2" min="-2" onChange={(event) => update(index, { strength: Number(event.target.value) })} step="0.05" type="number" value={item.strength} />
            </label>
            {item.inherited ? (
              <button
                aria-label={`${item.enabled ? "Escludi" : "Riattiva"} LoRA globale ${index + 1}`}
                className={item.enabled ? "job-lora-remove" : "job-lora-restore"}
                onClick={() => update(index, { enabled: !item.enabled })}
                title={item.enabled ? "Escludi questo LoRA globale soltanto dalla generazione corrente" : "Riattiva il LoRA globale per questa generazione"}
                type="button"
              >
                {item.enabled ? "Escludi" : "Riattiva"}
              </button>
            ) : (
              <button
                aria-label={`Rimuovi LoRA ${index + 1}`}
                className="job-lora-remove"
                onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                title="Rimuovi questo LoRA dalla generazione corrente"
                type="button"
              >
                Rimuovi
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="job-lora-actions">
        <button disabled={disabled || active >= MAX_JOB_LORAS || customCount >= MAX_JOB_LORAS} onClick={() => onChange([...value, { name: "", strength: 1, enabled: true }])} type="button">+ Aggiungi LoRA</button>
        <small>La compatibilità dipende dal modello selezionato; sono mostrati tutti i LoRA installati.</small>
      </div>
    </fieldset>
  );
}
