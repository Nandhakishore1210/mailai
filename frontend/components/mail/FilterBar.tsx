"use client";
import { useEffect, useState } from "react";
import { useMailStore } from "@/store/mailStore";
import { useUIStore } from "@/store/uiStore";
import { MailFilters, isMailBox } from "@/lib/types";
import { Search, X, SlidersHorizontal } from "lucide-react";
import { clsx } from "clsx";

const INPUT =
  "text-sm border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500";

function describe(filters: MailFilters): string[] {
  const chips: string[] = [];
  if (filters.keyword) chips.push(`"${filters.keyword}"`);
  if (filters.sender) chips.push(`from ${filters.sender}`);
  if (filters.unread) chips.push("unread");
  if (filters.newer_than_days) chips.push(`last ${filters.newer_than_days} days`);
  if (filters.from_date) chips.push(`from ${filters.from_date}`);
  if (filters.to_date) chips.push(`to ${filters.to_date}`);
  return chips;
}

export default function FilterBar() {
  const { filters, applyFilters, clearSearch, searchResults } = useMailStore();
  const currentView = useUIStore((s) => s.currentView);

  const [expanded, setExpanded] = useState(false);
  const [keyword, setKeyword] = useState(filters.keyword ?? "");
  const [sender, setSender] = useState(filters.sender ?? "");
  const [unread, setUnread] = useState(!!filters.unread);
  const [fromDate, setFromDate] = useState(filters.from_date ?? "");
  const [toDate, setToDate] = useState(filters.to_date ?? "");

  // Keep the controls in sync when the assistant changes the filters.
  useEffect(() => {
    setKeyword(filters.keyword ?? "");
    setSender(filters.sender ?? "");
    setUnread(!!filters.unread);
    setFromDate(filters.from_date ?? "");
    setToDate(filters.to_date ?? "");
    if (filters.sender || filters.from_date || filters.to_date) setExpanded(true);
  }, [filters]);

  const run = (override: Partial<MailFilters> = {}) => {
    const next: MailFilters = {
      keyword: keyword || undefined,
      sender: sender || undefined,
      unread: unread || undefined,
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
      newer_than_days: filters.newer_than_days,
      scope: isMailBox(currentView) ? currentView : "inbox",
      ...override,
    };
    const hasAny = Object.entries(next).some(([k, v]) => k !== "scope" && v !== undefined && v !== "");
    if (!hasAny) {
      clearSearch();
      return;
    }
    applyFilters(next);
  };

  const reset = () => {
    setKeyword("");
    setSender("");
    setUnread(false);
    setFromDate("");
    setToDate("");
    clearSearch();
  };

  const chips = describe(filters);
  const active = !!searchResults;

  return (
    <div className="border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900" data-testid="filter-bar">
      {/* Row 1: search + toggles */}
      <div className="flex items-center gap-1.5 px-3 py-2">
        <div className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            className={clsx(INPUT, "w-full pl-8 pr-2 py-1.5")}
            placeholder="Search emails…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            data-testid="filter-keyword"
          />
        </div>
        <button
          onClick={() => {
            const next = !unread;
            setUnread(next);
            run({ unread: next || undefined });
          }}
          className={clsx(
            "text-xs px-2.5 py-1.5 rounded-md border transition-colors whitespace-nowrap",
            unread
              ? "bg-brand-50 border-brand-300 text-brand-700 dark:bg-brand-900/40 dark:border-brand-700 dark:text-brand-300"
              : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          )}
          data-testid="filter-unread"
        >
          Unread
        </button>
        <button
          onClick={() => setExpanded((v) => !v)}
          className={clsx(
            "p-1.5 rounded-md border transition-colors",
            expanded
              ? "bg-gray-100 dark:bg-gray-800 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"
              : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
          )}
          title="More filters"
          data-testid="filter-more"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
      </div>

      {/* Row 2 (collapsible): sender + date range */}
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          <input
            className={clsx(INPUT, "w-full px-3 py-1.5")}
            placeholder="From (name or email)"
            value={sender}
            onChange={(e) => setSender(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            data-testid="filter-sender"
          />
          <div className="flex items-center gap-2">
            <input
              type="date"
              className={clsx(INPUT, "flex-1 min-w-0 text-xs px-2 py-1.5")}
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              title="From date"
              data-testid="filter-from-date"
            />
            <span className="text-xs text-gray-400">to</span>
            <input
              type="date"
              className={clsx(INPUT, "flex-1 min-w-0 text-xs px-2 py-1.5")}
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              title="To date"
              data-testid="filter-to-date"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => run()}
              className="flex-1 text-xs font-medium bg-brand-600 hover:bg-brand-700 text-white rounded-md py-1.5 transition-colors"
              data-testid="filter-apply"
            >
              Apply filters
            </button>
            <button
              onClick={reset}
              className="text-xs px-3 rounded-md border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* Active filter chips */}
      {active && chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-2" data-testid="active-filters">
          {chips.map((c) => (
            <span
              key={c}
              className="text-[11px] bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300 px-2 py-0.5 rounded-full"
            >
              {c}
            </span>
          ))}
          <button onClick={reset} className="ml-auto text-gray-400 hover:text-gray-600 dark:hover:text-gray-200" title="Clear filters">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
