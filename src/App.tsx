import React, { useState, useEffect, useMemo } from 'react';
import {
  UserPlus,
  PhoneCall,
  CheckCircle2,
  SkipForward,
  Clock,
  UserCheck,
  Search,
  Lock,
  Unlock,
  RotateCcw,
  Volume2,
  VolumeX,
  Trash2,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import {
  QueueStatus,
  QueueCustomer,
  QueueActivityEntry,
  IssuedTicketReceipt,
} from './types/queue';
import {
  INITIAL_CUSTOMERS,
  INITIAL_ACTIVITY_LOG,
  SERVICE_PURPOSES,
} from './data/initialQueue';

const STORAGE_KEY_CUSTOMERS = 'queueline_customers_v1';
const STORAGE_KEY_NEXT_SEQ = 'queueline_next_seq_v1';
const STORAGE_KEY_ACTIVITY = 'queueline_activity_v1';
const DEFAULT_STAFF_PIN = '1234';

function formatCurrentTime(): string {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function playCallChime(enabled: boolean) {
  if (!enabled || typeof window === 'undefined') return;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    // Two-tone pleasant service counter chime (E5 -> C5)
    const freqs = [659.25, 523.25];
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.22);

      gain.gain.setValueAtTime(0.001, now + idx * 0.22);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.22 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.22 + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.22);
      osc.stop(now + idx * 0.22 + 0.48);
    });
  } catch {
    // Ignore audio errors if blocked by browser autoplay policy
  }
}

export default function App() {
  // Queue state with localStorage persistence
  const [customers, setCustomers] = useState<QueueCustomer[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CUSTOMERS);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Fallback to initial
    }
    return INITIAL_CUSTOMERS;
  });

  const [nextSequence, setNextSequence] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_NEXT_SEQ);
      if (saved) {
        const num = parseInt(saved, 10);
        if (!Number.isNaN(num) && num >= 101) return num;
      }
    } catch {
      // Fallback
    }
    return 108;
  });

  const [activityLog, setActivityLog] = useState<QueueActivityEntry[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_ACTIVITY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Fallback
    }
    return INITIAL_ACTIVITY_LOG;
  });

  // Customer Check-In Form State
  const [customerName, setCustomerName] = useState('');
  const [customerPurpose, setCustomerPurpose] = useState(SERVICE_PURPOSES[0]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastIssuedTicket, setLastIssuedTicket] = useState<IssuedTicketReceipt | null>(null);

  // Staff Authorization & Controls State
  const [isStaffAuthorized, setIsStaffAuthorized] = useState<boolean>(true);
  const [showPinPrompt, setShowPinPrompt] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [staffBannerMessage, setStaffBannerMessage] = useState<{
    type: 'info' | 'warning' | 'success';
    text: string;
  } | null>(null);

  // Staff Console Filtering & Search State
  const [statusFilter, setStatusFilter] = useState<'ALL' | QueueStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Sync to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_CUSTOMERS, JSON.stringify(customers));
      localStorage.setItem(STORAGE_KEY_NEXT_SEQ, String(nextSequence));
      localStorage.setItem(STORAGE_KEY_ACTIVITY, JSON.stringify(activityLog));
    } catch {
      // Ignore storage quota issues
    }
  }, [customers, nextSequence, activityLog]);

  // Cross-tab synchronization
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY_CUSTOMERS && e.newValue) {
        try {
          setCustomers(JSON.parse(e.newValue));
        } catch {
          // Ignore
        }
      }
      if (e.key === STORAGE_KEY_NEXT_SEQ && e.newValue) {
        const parsed = parseInt(e.newValue, 10);
        if (!Number.isNaN(parsed)) setNextSequence(parsed);
      }
      if (e.key === STORAGE_KEY_ACTIVITY && e.newValue) {
        try {
          setActivityLog(JSON.parse(e.newValue));
        } catch {
          // Ignore
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Derived Queue Segments (strictly ordered by sequenceNumber)
  const sortedCustomers = useMemo(() => {
    return [...customers].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }, [customers]);

  const currentlyServing = useMemo(() => {
    return sortedCustomers.find((c) => c.status === QueueStatus.Serving) || null;
  }, [sortedCustomers]);

  const waitingCustomers = useMemo(() => {
    return sortedCustomers.filter((c) => c.status === QueueStatus.Waiting);
  }, [sortedCustomers]);

  const nextWaitingCustomer = useMemo(() => {
    return waitingCustomers.length > 0 ? waitingCustomers[0] : null;
  }, [waitingCustomers]);

  const counts = useMemo(() => {
    return {
      total: sortedCustomers.length,
      waiting: sortedCustomers.filter((c) => c.status === QueueStatus.Waiting).length,
      serving: sortedCustomers.filter((c) => c.status === QueueStatus.Serving).length,
      served: sortedCustomers.filter((c) => c.status === QueueStatus.Served).length,
      skipped: sortedCustomers.filter((c) => c.status === QueueStatus.Skipped).length,
    };
  }, [sortedCustomers]);

  const filteredStaffCustomers = useMemo(() => {
    return sortedCustomers.filter((customer) => {
      const matchesStatus =
        statusFilter === 'ALL' ? true : customer.status === statusFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        customer.name.toLowerCase().includes(q) ||
        customer.queueCode.toLowerCase().includes(q) ||
        customer.purpose.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [sortedCustomers, statusFilter, searchQuery]);

  const logActivity = (queueCode: string, name: string, description: string) => {
    const newEntry: QueueActivityEntry = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: formatCurrentTime(),
      queueCode,
      customerName: name,
      description,
    };
    setActivityLog((prev) => [newEntry, ...prev.slice(0, 24)]);
  };

  // Requirement 1 & 2: Customer enters name and joins queue with unique auto-assigned queue number
  const handleJoinQueue = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = customerName.trim();
    if (!trimmedName) {
      setFormError('Please enter the customer name to assign a queue number.');
      return;
    }
    if (trimmedName.length < 2) {
      setFormError('Customer name must be at least 2 characters.');
      return;
    }

    const assignedSeq = nextSequence;
    const assignedCode = `Q-${String(assignedSeq).padStart(3, '0')}`;
    const timeStr = formatCurrentTime();
    const waitingAheadCount = waitingCustomers.length;

    const newCustomer: QueueCustomer = {
      id: `cust-${assignedSeq}-${Date.now()}`,
      sequenceNumber: assignedSeq,
      queueCode: assignedCode,
      name: trimmedName,
      purpose: customerPurpose,
      status: QueueStatus.Waiting,
      joinedAt: timeStr,
    };

    setCustomers((prev) => [...prev, newCustomer]);
    setNextSequence((prev) => prev + 1);
    setCustomerName('');
    setFormError(null);

    setLastIssuedTicket({
      queueCode: assignedCode,
      name: trimmedName,
      purpose: customerPurpose,
      joinedAt: timeStr,
      waitingAhead: waitingAheadCount,
    });

    logActivity(assignedCode, trimmedName, `Joined waiting queue (${customerPurpose})`);
  };

  // Requirement 4, 6, 7: Allow authorized staff to call the next waiting customer
  // Prevents Served or Skipped customers from being called as the next active customer
  const handleCallNextCustomer = () => {
    if (!isStaffAuthorized) {
      setShowPinPrompt(true);
      setStaffBannerMessage({
        type: 'warning',
        text: 'Staff authorization is locked. Unlock staff controls (PIN: 1234) to call the next customer.',
      });
      return;
    }

    const timeStr = formatCurrentTime();

    // Strictly select only from customers currently in 'Waiting' status (Req 7)
    const nextCandidate = waitingCustomers[0];

    if (!nextCandidate) {
      // If someone is currently being served and no one is waiting, let staff know
      if (currentlyServing) {
        setStaffBannerMessage({
          type: 'info',
          text: `No customers are currently waiting in line. ${currentlyServing.queueCode} (${currentlyServing.name}) is still being served.`,
        });
      } else {
        setStaffBannerMessage({
          type: 'info',
          text: 'No customers with Waiting status are available to call. Served and Skipped customers are automatically excluded.',
        });
      }
      return;
    }

    const previousServing = currentlyServing;

    setCustomers((prev) =>
      prev.map((cust) => {
        // Complete any currently active Serving customer automatically when calling next
        if (cust.status === QueueStatus.Serving) {
          return {
            ...cust,
            status: QueueStatus.Served,
            completedAt: timeStr,
          };
        }
        // Transition the earliest Waiting customer to Serving
        if (cust.id === nextCandidate.id) {
          return {
            ...cust,
            status: QueueStatus.Serving,
            calledAt: timeStr,
          };
        }
        return cust;
      })
    );

    playCallChime(soundEnabled);

    if (previousServing) {
      logActivity(
        previousServing.queueCode,
        previousServing.name,
        'Completed service · Marked as Served'
      );
    }
    logActivity(
      nextCandidate.queueCode,
      nextCandidate.name,
      'Called as next active customer · Status set to Serving'
    );

    setStaffBannerMessage({
      type: 'success',
      text: previousServing
        ? `Completed ${previousServing.queueCode} (${previousServing.name}) and called next waiting customer: ${nextCandidate.queueCode} — ${nextCandidate.name}.`
        : `Now serving ${nextCandidate.queueCode} — ${nextCandidate.name}.`,
    });
  };

  // Requirement 5 & 7: Allow staff to mark customers as Waiting, Serving, Served, Skipped
  // While preventing already Served or Skipped customers from being directly called as Serving
  const handleUpdateCustomerStatus = (
    targetCustomer: QueueCustomer,
    newStatus: QueueStatus
  ) => {
    if (!isStaffAuthorized) {
      setShowPinPrompt(true);
      setStaffBannerMessage({
        type: 'warning',
        text: 'Unlock Staff Authorization (PIN: 1234) to update customer queue statuses.',
      });
      return;
    }

    if (targetCustomer.status === newStatus) return;

    // Requirement 7 enforcement: Prevent already Served or Skipped customers from being called directly as Serving
    if (
      newStatus === QueueStatus.Serving &&
      (targetCustomer.status === QueueStatus.Served ||
        targetCustomer.status === QueueStatus.Skipped)
    ) {
      setStaffBannerMessage({
        type: 'warning',
        text: `Cannot call ${targetCustomer.queueCode} (${targetCustomer.name}) directly because their status is ${targetCustomer.status}. Mark as Waiting first if you need to re-queue them.`,
      });
      return;
    }

    const timeStr = formatCurrentTime();

    setCustomers((prev) =>
      prev.map((cust) => {
        // Ensure only one customer is 'Serving' at a time on a single service counter
        if (
          newStatus === QueueStatus.Serving &&
          cust.status === QueueStatus.Serving &&
          cust.id !== targetCustomer.id
        ) {
          return {
            ...cust,
            status: QueueStatus.Served,
            completedAt: timeStr,
          };
        }

        if (cust.id === targetCustomer.id) {
          return {
            ...cust,
            status: newStatus,
            calledAt:
              newStatus === QueueStatus.Serving ? timeStr : cust.calledAt,
            completedAt:
              newStatus === QueueStatus.Served ||
              newStatus === QueueStatus.Skipped
                ? timeStr
                : undefined,
          };
        }

        return cust;
      })
    );

    if (newStatus === QueueStatus.Serving) {
      playCallChime(soundEnabled);
    }

    logActivity(
      targetCustomer.queueCode,
      targetCustomer.name,
      `Status changed from ${targetCustomer.status} to ${newStatus}`
    );

    setStaffBannerMessage({
      type: 'info',
      text: `Updated ${targetCustomer.queueCode} (${targetCustomer.name}) status to ${newStatus}.`,
    });
  };

  // Staff PIN authentication handler
  const handleUnlockStaff = (e: React.FormEvent) => {
    e.preventDefault();
    if (pinInput.trim() === DEFAULT_STAFF_PIN) {
      setIsStaffAuthorized(true);
      setShowPinPrompt(false);
      setPinInput('');
      setPinError(null);
      setStaffBannerMessage({
        type: 'success',
        text: 'Staff console authorized. Queue management controls are active.',
      });
    } else {
      setPinError('Incorrect staff PIN. Use default PIN 1234.');
    }
  };

  const handleResetDemoData = () => {
    if (!isStaffAuthorized) {
      setShowPinPrompt(true);
      return;
    }
    setCustomers(INITIAL_CUSTOMERS);
    setNextSequence(108);
    setActivityLog(INITIAL_ACTIVITY_LOG);
    setLastIssuedTicket(null);
    setStaffBannerMessage({
      type: 'info',
      text: 'Queue restored to initial sample state (Q-101 through Q-107).',
    });
  };

  const handleClearAllQueue = () => {
    if (!isStaffAuthorized) {
      setShowPinPrompt(true);
      return;
    }
    setCustomers([]);
    setNextSequence(101);
    setActivityLog([]);
    setLastIssuedTicket(null);
    setStaffBannerMessage({
      type: 'info',
      text: 'All queue entries cleared. Next customer will be assigned Q-101.',
    });
  };

  // Semantic status presentation (unboxed text + icon, never hue-only, zero pill containers)
  const renderStatusText = (status: QueueStatus) => {
    switch (status) {
      case QueueStatus.Serving:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700 whitespace-nowrap">
            <UserCheck className="w-3.5 h-3.5 shrink-0" />
            <span>Serving</span>
          </span>
        );
      case QueueStatus.Waiting:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 whitespace-nowrap">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Waiting</span>
          </span>
        );
      case QueueStatus.Served:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 whitespace-nowrap">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Served</span>
          </span>
        );
      case QueueStatus.Skipped:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 whitespace-nowrap">
            <SkipForward className="w-3.5 h-3.5 shrink-0" />
            <span>Skipped</span>
          </span>
        );
    }
  };

  return (
    <div id="top" className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Strictly 3-Zone Top Navigation Bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-8 px-6 lg:px-10 py-3.5 bg-white/95 backdrop-blur border-b border-slate-200">
        {/* Zone 1: Brand Title (one line, single text element) */}
        <a
          href="#top"
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          QueueLine
        </a>

        {/* Zone 2: 4 concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
          <a
            href="#live-display"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Live Display
          </a>
          <a
            href="#join-queue"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Join Queue
          </a>
          <a
            href="#waiting-list"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Waiting List
          </a>
          <a
            href="#staff-console"
            className="hover:text-slate-900 hover:underline underline-offset-4 transition-colors whitespace-nowrap shrink-0"
          >
            Staff Console
          </a>
        </nav>

        {/* Zone 3: 1 Primary Action Button */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handleCallNextCustomer}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 active:scale-[0.99] transition-all whitespace-nowrap shrink-0 cursor-pointer"
          >
            <PhoneCall className="w-3.5 h-3.5" />
            <span>Call Next Customer</span>
          </button>
        </div>
      </header>

      {/* Main Content Container (1440px desktop baseline) */}
      <main className="flex-1 w-full max-w-[1360px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* Section 1: Live Now Serving Focal Anchor + Key Queue Telemetry */}
        <section id="live-display" className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500">
                Single Service Counter · Sequential Digital Queue
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-0.5">
                Live Counter Status &amp; Queue Monitor
              </h1>
            </div>

            {/* Audio Chime & Staff Lock Status Controls */}
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setSoundEnabled((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                title="Toggle counter call chime"
              >
                {soundEnabled ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5 text-slate-700" />
                    <span>Chime On</span>
                  </>
                ) : (
                  <>
                    <VolumeX className="w-3.5 h-3.5 text-slate-400" />
                    <span>Chime Muted</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  if (isStaffAuthorized) {
                    setIsStaffAuthorized(false);
                    setStaffBannerMessage({
                      type: 'info',
                      text: 'Staff Console locked. Public kiosk mode active.',
                    });
                  } else {
                    setShowPinPrompt(true);
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isStaffAuthorized
                    ? 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
                    : 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                }`}
              >
                {isStaffAuthorized ? (
                  <>
                    <Unlock className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Staff Authorized</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-3.5 h-3.5 text-amber-600" />
                    <span>Staff Locked (Unlock)</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Staff PIN Modal / Inline Unlock Bar when locked */}
          {showPinPrompt && !isStaffAuthorized && (
            <form
              onSubmit={handleUnlockStaff}
              className="p-4 bg-white border border-slate-300 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4"
            >
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <ShieldCheck className="w-4 h-4 text-slate-700" />
                  <span>Staff Authorization Required</span>
                </div>
                <p className="text-xs text-slate-600">
                  Enter the staff PIN to unlock calling and status changes (Default PIN: <span className="font-mono font-semibold">1234</span>).
                </p>
                {pinError && (
                  <p className="text-xs font-medium text-rose-600 pt-1">{pinError}</p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="password"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  placeholder="PIN (1234)"
                  aria-label="Staff PIN"
                  className="w-32 px-3 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <button
                  type="submit"
                  className="px-3.5 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Verify PIN
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setIsStaffAuthorized(true);
                    setShowPinPrompt(false);
                    setPinError(null);
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Quick Authorize
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowPinPrompt(false);
                    setPinError(null);
                  }}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {/* Dominant Visual Focal Anchor: Now Serving Board + Next Up */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 items-stretch">
              {/* Left 7 Cols: Currently Being Served (Requirement 6) */}
              <div className="lg:col-span-7 p-6 sm:p-8 flex flex-col justify-between bg-slate-900 text-white">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-xs font-medium tracking-wide text-slate-300">
                    Now Serving at Service Counter
                  </span>
                  <span className="text-xs font-mono text-slate-400 tabular-nums">
                    {currentlyServing
                      ? `Called at ${currentlyServing.calledAt || currentlyServing.joinedAt}`
                      : 'Counter Standby'}
                  </span>
                </div>

                {currentlyServing ? (
                  <div className="my-6 flex flex-col sm:flex-row sm:items-baseline justify-between gap-4">
                    <div>
                      <div
                        className="text-5xl sm:text-6xl font-bold font-mono tracking-tight text-white tabular-nums"
                        data-testid="now-serving-number"
                      >
                        {currentlyServing.queueCode}
                      </div>
                      <div
                        className="text-xl sm:text-2xl font-semibold text-slate-100 mt-2"
                        data-testid="now-serving-name"
                      >
                        {currentlyServing.name}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-300 mt-1">
                        <span>{currentlyServing.purpose}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          Joined {currentlyServing.joinedAt}
                        </span>
                      </div>
                    </div>

                    {/* Direct Staff Actions for the Active Customer */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0 pt-2 sm:pt-0">
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateCustomerStatus(
                            currentlyServing,
                            QueueStatus.Served
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Mark Served</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateCustomerStatus(
                            currentlyServing,
                            QueueStatus.Skipped
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-800 border border-slate-700 rounded-lg hover:bg-rose-950 hover:border-rose-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <SkipForward className="w-3.5 h-3.5" />
                        <span>Mark Skipped</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateCustomerStatus(
                            currentlyServing,
                            QueueStatus.Waiting
                          )
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-slate-800/70 rounded-lg hover:bg-slate-800 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Clock className="w-3.5 h-3.5" />
                        <span>Return to Waiting</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="my-8">
                    <div
                      className="text-4xl sm:text-5xl font-bold font-mono text-slate-400 tabular-nums"
                      data-testid="now-serving-number"
                    >
                      — — —
                    </div>
                    <p className="text-base font-medium text-slate-200 mt-2">
                      No customer is currently being served
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      {waitingCustomers.length > 0
                        ? `${waitingCustomers.length} customer(s) waiting in line. Click "Call Next Customer" to serve ${waitingCustomers[0].queueCode}.`
                        : 'The waiting line is currently empty. New customers can join below.'}
                    </p>
                  </div>
                )}

                <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="text-xs text-slate-300">
                    {nextWaitingCustomer ? (
                      <span>
                        Next in waiting line:{' '}
                        <strong className="font-mono text-white tabular-nums">
                          {nextWaitingCustomer.queueCode}
                        </strong>{' '}
                        ({nextWaitingCustomer.name})
                      </span>
                    ) : (
                      <span>No additional customers waiting in queue</span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={handleCallNextCustomer}
                    disabled={waitingCustomers.length === 0}
                    className={`inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                      waitingCustomers.length > 0
                        ? 'bg-white text-slate-900 hover:bg-slate-100 cursor-pointer'
                        : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    }`}
                  >
                    <PhoneCall className="w-3.5 h-3.5" />
                    <span>
                      {waitingCustomers.length > 0
                        ? `Call Next (${waitingCustomers[0].queueCode})`
                        : 'No Waiting Customers'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Right 5 Cols: Real-Time Queue Summary Metrics (4-Metric Grid) */}
              <div className="lg:col-span-5 grid grid-cols-2 divide-x divide-y divide-slate-200 bg-white">
                <div className="p-6 flex flex-col justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    Currently Waiting
                  </span>
                  <div className="mt-3">
                    <div
                      className="text-3xl font-bold font-mono text-amber-700 tabular-nums"
                      data-testid="metric-waiting-count"
                    >
                      {counts.waiting}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      In sequential line order
                    </p>
                  </div>
                </div>

                <div className="p-6 flex flex-col justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    Currently Serving
                  </span>
                  <div className="mt-3">
                    <div className="text-3xl font-bold font-mono text-emerald-700 tabular-nums">
                      {counts.serving}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      {currentlyServing
                        ? `${currentlyServing.queueCode} active`
                        : 'Counter idle'}
                    </p>
                  </div>
                </div>

                <div className="p-6 flex flex-col justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    Served Today
                  </span>
                  <div className="mt-3">
                    <div
                      className="text-3xl font-bold font-mono text-slate-900 tabular-nums"
                      data-testid="metric-served-count"
                    >
                      {counts.served}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      Completed &amp; closed
                    </p>
                  </div>
                </div>

                <div className="p-6 flex flex-col justify-between">
                  <span className="text-xs font-medium text-slate-500">
                    Skipped Tickets
                  </span>
                  <div className="mt-3">
                    <div
                      className="text-3xl font-bold font-mono text-rose-700 tabular-nums"
                      data-testid="metric-skipped-count"
                    >
                      {counts.skipped}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      Excluded from auto-call
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 2: Two-Column Split — Customer Join Queue (Left) & Currently Waiting List (Right) */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left 5 Columns: Customer Check-In / Join Queue Form (Req 1 & Req 2) */}
          <div
            id="join-queue"
            className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-7 flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    Customer Queue Check-In
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Enter your name to receive a unique sequential queue number
                  </p>
                </div>
                <span className="text-xs font-mono font-semibold text-slate-700 tabular-nums">
                  Next Ticket: Q-{String(nextSequence).padStart(3, '0')}
                </span>
              </div>

              <form onSubmit={handleJoinQueue} className="mt-5 space-y-4">
                <div>
                  <label
                    htmlFor="customer-name-input"
                    className="block text-xs font-semibold text-slate-800 mb-1.5"
                  >
                    Customer Full Name <span className="text-rose-600">*</span>
                  </label>
                  <input
                    id="customer-name-input"
                    type="text"
                    value={customerName}
                    onChange={(e) => {
                      setCustomerName(e.target.value);
                      if (formError) setFormError(null);
                    }}
                    placeholder="e.g., Jordan Rivera"
                    className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 transition-colors"
                  />
                  {formError && (
                    <p className="text-xs font-medium text-rose-600 mt-1.5">
                      {formError}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="customer-purpose-select"
                    className="block text-xs font-semibold text-slate-800 mb-1.5"
                  >
                    Service Category
                  </label>
                  <select
                    id="customer-purpose-select"
                    value={customerPurpose}
                    onChange={(e) => setCustomerPurpose(e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 transition-colors"
                  >
                    {SERVICE_PURPOSES.map((purpose) => (
                      <option key={purpose} value={purpose}>
                        {purpose}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="submit"
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 active:scale-[0.99] transition-all whitespace-nowrap cursor-pointer"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Join Queue &amp; Issue Number</span>
                </button>
              </form>
            </div>

            {/* Issued Ticket Receipt Feedback */}
            <div className="mt-6 pt-5 border-t border-slate-200">
              {lastIssuedTicket ? (
                <div
                  className="space-y-2"
                   role="status"
                  aria-live="polite"
                  data-testid="issued-ticket-receipt"
                >
                  <div className="flex items-center justify-between text-xs text-emerald-700 font-semibold">
                    <span>Ticket Issued Successfully</span>
                    <span className="font-mono tabular-nums">
                      {lastIssuedTicket.joinedAt}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 pt-1">
                    <div>
                      <div className="text-xs text-slate-500">
                        Assigned Queue Number
                      </div>
                      <div className="text-2xl font-bold font-mono text-slate-900 tabular-nums">
                        {lastIssuedTicket.queueCode}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-slate-900">
                        {lastIssuedTicket.name}
                      </div>
                      <div className="text-xs text-slate-500">
                        {lastIssuedTicket.purpose} ·{' '}
                        <span className="font-mono tabular-nums">
                          {lastIssuedTicket.waitingAhead}
                        </span>{' '}
                        ahead in line
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-slate-500 space-y-1">
                  <p className="font-medium text-slate-700">
                    Automatic Sequential Numbering
                  </p>
                  <p>
                    Each customer who joins receives a unique queue code in strict arrival order and is placed directly into the active waiting list.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Right 7 Columns: Customers Currently Waiting List (Requirement 3) */}
          <div
            id="waiting-list"
            className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 sm:p-7 flex flex-col justify-between"
          >
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    Customers Currently Waiting
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Live sequential waiting order · Next customer is called from the top of this list
                  </p>
                </div>
                <div className="text-xs font-medium text-slate-600 tabular-nums">
                  <span className="font-mono font-bold text-slate-900">
                    {waitingCustomers.length}
                  </span>{' '}
                  {waitingCustomers.length === 1
                    ? 'customer waiting'
                    : 'customers waiting'}
                </div>
              </div>

              {waitingCustomers.length > 0 ? (
                <div className="divide-y divide-slate-200 mt-2">
                  {waitingCustomers.map((customer, index) => {
                    const isNextUp = index === 0;
                    return (
                      <div
                        key={customer.id}
                        className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors px-2 -mx-2 rounded-lg"
                      >
                        <div className="flex items-center gap-4 min-w-0">
                          <div className="w-8 text-xs font-mono font-semibold text-slate-400 tabular-nums shrink-0">
                            #{index + 1}
                          </div>
                          <div className="text-base font-bold font-mono text-slate-900 tabular-nums shrink-0">
                            {customer.queueCode}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-slate-900 truncate">
                                {customer.name}
                              </span>
                              {isNextUp && (
                                <span className="text-xs font-semibold text-amber-700 whitespace-nowrap">
                                  · Next to be called
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <span className="truncate">{customer.purpose}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                Joined {customer.joinedAt}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Quick Staff Action on Waiting List Item */}
                        <div className="flex items-center gap-3 self-end sm:self-center shrink-0">
                          {renderStatusText(customer.status)}
                          <button
                            type="button"
                            onClick={() =>
                              handleUpdateCustomerStatus(
                                customer,
                                QueueStatus.Serving
                              )
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 rounded-md hover:bg-slate-900 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                            title={`Call ${customer.queueCode} now`}
                          >
                            <span>Call</span>
                            <ArrowRight className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* Empty Waiting Queue State */
                <div className="py-12 text-center space-y-3">
                  <p className="text-sm font-semibold text-slate-800">
                    No customers are currently waiting
                  </p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    All issued queue numbers have been served or skipped. Use the Customer Queue Check-In form to add the next arriving customer.
                  </p>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        const input = document.getElementById(
                          'customer-name-input'
                        );
                        if (input) input.focus();
                      }}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-900 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>Focus Customer Check-In</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4 pt-4 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
              <span>
                Only customers with <strong>Waiting</strong> status appear here and are eligible for next call.
              </span>
              <span className="font-mono tabular-nums">
                Total Records: {counts.total}
              </span>
            </div>
          </div>
        </section>

        {/* Section 3: Authorized Staff Queue Management Console (Req 4, 5, 7) */}
        <section
          id="staff-console"
          className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 space-y-5"
        >
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-5">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">
                  Authorized Staff Queue Management Console
                </h2>
                <span className="text-xs text-slate-500">
                  · Status Control &amp; Sequential Enforcement
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Manage all queue tickets across Waiting, Serving, Served, and Skipped states. Already Served or Skipped customers are prevented from being called as the next active customer.
              </p>
            </div>

            {/* Staff Primary Actions */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleCallNextCustomer}
                disabled={waitingCustomers.length === 0}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                  waitingCustomers.length > 0
                    ? 'bg-slate-900 text-white hover:bg-slate-800 cursor-pointer'
                    : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
              >
                <PhoneCall className="w-3.5 h-3.5" />
                <span>Call Next Waiting Customer</span>
              </button>

              <button
                type="button"
                onClick={handleResetDemoData}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Sample Queue</span>
              </button>

              <button
                type="button"
                onClick={handleClearAllQueue}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-700 bg-rose-50 rounded-lg hover:bg-rose-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear Queue</span>
              </button>
            </div>
          </div>

          {/* Staff Operational Feedback Banner */}
          {staffBannerMessage && (
            <div
              className={`px-4 py-3 rounded-lg border flex items-center justify-between gap-4 text-xs ${
                staffBannerMessage.type === 'warning'
                  ? 'bg-amber-50 border-amber-200 text-amber-900'
                  : staffBannerMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
              role="status"
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span className="font-medium">{staffBannerMessage.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setStaffBannerMessage(null)}
                className="text-xs font-semibold underline hover:no-underline whitespace-nowrap shrink-0 cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Filter Tabs & Search Bar */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            {/* Functional Segmented Filter Buttons */}
            <div
              className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg self-start"
              role="group"
              aria-label="Filter queue by status"
            >
              {(
                [
                  { id: 'ALL', label: `All (${counts.total})` },
                  {
                    id: QueueStatus.Waiting,
                    label: `Waiting (${counts.waiting})`,
                  },
                  {
                    id: QueueStatus.Serving,
                    label: `Serving (${counts.serving})`,
                  },
                  {
                    id: QueueStatus.Served,
                    label: `Served (${counts.served})`,
                  },
                  {
                    id: QueueStatus.Skipped,
                    label: `Skipped (${counts.skipped})`,
                  },
                ] as const
              ).map((tab) => {
                const active = statusFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 tabular-nums cursor-pointer ${
                      active
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Search Input */}
            <div className="relative w-full md:w-72">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search queue # or customer name..."
                aria-label="Search queue number or customer name"
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
          </div>

          {/* High-Density Queue Data Table */}
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4 whitespace-nowrap">Queue #</th>
                  <th className="py-3 px-4 whitespace-nowrap">Customer Name</th>
                  <th className="py-3 px-4 whitespace-nowrap">Service Category</th>
                  <th className="py-3 px-4 whitespace-nowrap">Timestamps</th>
                  <th className="py-3 px-4 whitespace-nowrap">Current Status</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">
                    Staff Status Controls (Mark Customer As)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredStaffCustomers.length > 0 ? (
                  filteredStaffCustomers.map((customer) => {
                    const isServedOrSkipped =
                      customer.status === QueueStatus.Served ||
                      customer.status === QueueStatus.Skipped;

                    return (
                      <tr
                        key={customer.id}
                        className={`transition-colors ${
                          customer.status === QueueStatus.Serving
                            ? 'bg-emerald-50/40 hover:bg-emerald-50/70'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-3 px-4 font-mono font-bold text-slate-900 tabular-nums whitespace-nowrap">
                          {customer.queueCode}
                        </td>
                        <td className="py-3 px-4 font-semibold text-slate-900 whitespace-nowrap">
                          {customer.name}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                          {customer.purpose}
                        </td>
                        <td className="py-3 px-4 text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
                          <span>In {customer.joinedAt}</span>
                          {customer.calledAt && (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span>Called {customer.calledAt}</span>
                            </>
                          )}
                          {customer.completedAt && (
                            <>
                              <span aria-hidden="true"> · </span>
                              <span>Done {customer.completedAt}</span>
                            </>
                          )}
                        </td>
                        <td className="py-3 px-4 whitespace-nowrap">
                          {renderStatusText(customer.status)}
                        </td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center justify-end gap-1">
                            {/* Mark as Waiting */}
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateCustomerStatus(
                                  customer,
                                  QueueStatus.Waiting
                                )
                              }
                              disabled={customer.status === QueueStatus.Waiting}
                              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                                customer.status === QueueStatus.Waiting
                                  ? 'bg-amber-600 text-white border-amber-600 font-semibold cursor-default'
                                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 cursor-pointer'
                              }`}
                            >
                              Waiting
                            </button>

                            {/* Mark as Serving (Disabled if already Served or Skipped per Req 7) */}
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateCustomerStatus(
                                  customer,
                                  QueueStatus.Serving
                                )
                              }
                              disabled={
                                customer.status === QueueStatus.Serving ||
                                isServedOrSkipped
                              }
                              title={
                                isServedOrSkipped
                                  ? 'Already Served or Skipped customers cannot be called directly as the active customer. Mark as Waiting first to re-queue.'
                                  : 'Call and mark customer as Serving'
                              }
                              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                                customer.status === QueueStatus.Serving
                                  ? 'bg-emerald-600 text-white border-emerald-600 font-semibold cursor-default'
                                  : isServedOrSkipped
                                  ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed'
                                  : 'bg-white text-slate-700 border-slate-200 hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-300 cursor-pointer'
                              }`}
                            >
                              Serving
                            </button>

                            {/* Mark as Served */}
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateCustomerStatus(
                                  customer,
                                  QueueStatus.Served
                                )
                              }
                              disabled={customer.status === QueueStatus.Served}
                              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                                customer.status === QueueStatus.Served
                                  ? 'bg-slate-800 text-white border-slate-800 font-semibold cursor-default'
                                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 cursor-pointer'
                              }`}
                            >
                              Served
                            </button>

                            {/* Mark as Skipped */}
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateCustomerStatus(
                                  customer,
                                  QueueStatus.Skipped
                                )
                              }
                              disabled={customer.status === QueueStatus.Skipped}
                              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                                customer.status === QueueStatus.Skipped
                                  ? 'bg-rose-600 text-white border-rose-600 font-semibold cursor-default'
                                  : 'bg-white text-slate-700 border-slate-200 hover:bg-rose-50 hover:text-rose-800 hover:border-rose-300 cursor-pointer'
                              }`}
                            >
                              Skipped
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-10 px-4 text-center text-xs text-slate-500"
                    >
                      No queue records match the current filter.{' '}
                      {statusFilter !== 'ALL' || searchQuery ? (
                        <button
                          type="button"
                          onClick={() => {
                            setStatusFilter('ALL');
                            setSearchQuery('');
                          }}
                          className="font-semibold text-slate-900 underline ml-1 cursor-pointer"
                        >
                          Reset filters
                        </button>
                      ) : (
                        <span>
                          Use the Customer Check-In form above to issue the first queue ticket.
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Recent Activity Log & Sequential Safeguard Note */}
          <div className="pt-2 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div className="lg:col-span-7 space-y-2">
              <h3 className="text-xs font-semibold text-slate-800">
                Recent Counter Activity
              </h3>
              {activityLog.length > 0 ? (
                <div className="divide-y divide-slate-200 border-t border-b border-slate-200">
                  {activityLog.slice(0, 4).map((entry) => (
                    <div
                      key={entry.id}
                      className="py-2 flex items-center justify-between gap-4 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono font-bold text-slate-900 tabular-nums shrink-0">
                          {entry.queueCode}
                        </span>
                        <span className="font-medium text-slate-800 truncate">
                          {entry.customerName}
                        </span>
                        <span aria-hidden="true" className="text-slate-400">
                          ·
                        </span>
                        <span className="text-slate-600 truncate">
                          {entry.description}
                        </span>
                      </div>
                      <span className="font-mono text-slate-400 tabular-nums shrink-0">
                        {entry.timestamp}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  No activity recorded in this session yet.
                </p>
              )}
            </div>

            <div className="lg:col-span-5 text-xs text-slate-600 space-y-1.5 bg-slate-50 p-4 rounded-lg border border-slate-200">
              <div className="font-semibold text-slate-900">
                Sequential Queue Safeguards
              </div>
              <p>
                1. <strong>Call Next Customer</strong> strictly selects the earliest customer in <strong>Waiting</strong> status and automatically completes any currently <strong>Serving</strong> ticket.
              </p>
              <p>
                2. Tickets marked <strong>Served</strong> or <strong>Skipped</strong> are locked from being called as the next active customer unless staff explicitly re-queue them to <strong>Waiting</strong>.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 bg-white px-6 lg:px-10 py-4 mt-8">
        <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <span>QueueLine — Single-Counter Digital Queue Management System</span>
          <div className="flex items-center gap-4">
            <a href="#live-display" className="hover:text-slate-900">
              Live Display
            </a>
            <span aria-hidden="true">·</span>
            <a href="#join-queue" className="hover:text-slate-900">
              Customer Check-In
            </a>
            <span aria-hidden="true">·</span>
            <a href="#staff-console" className="hover:text-slate-900">
              Staff Console
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
