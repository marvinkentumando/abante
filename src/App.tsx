import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  UserPlus,
  PhoneCall,
  CheckCircle2,
  SkipForward,
  Clock,
  UserCheck,
  Search,
  Lock,
  RotateCcw,
  Volume2,
  VolumeX,
  Trash2,
  AlertCircle,
  ShieldCheck,
  LogIn,
  LogOut,
  Users,
  Printer,
  Download,
  BellRing,
  HeartHandshake,
  Megaphone,
} from 'lucide-react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  serverTimestamp,
  writeBatch,
  runTransaction,
  deleteField,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  OperationType,
  handleFirestoreError,
} from './firebase';
import {
  QueueStatus,
  QueueCustomer,
  QueueActivityEntry,
  IssuedTicketReceipt,
  PriorityCategory,
} from './types/queue';
import {
  INITIAL_CUSTOMERS,
  INITIAL_ACTIVITY_LOG,
  SERVICE_PURPOSES,
  PRIORITY_CATEGORIES,
} from './data/initialQueue';

const SHARED_FACILITY_ID = 'main-counter';
const BOOTSTRAPPED_ADMIN_EMAIL = 'tumando.marvinken@dnsc.edu.ph';

// Blueprint validation constants (synced with firebase-blueprint.json & firestore.rules)
const MAX_NAME_LENGTH = 80;
const MAX_PURPOSE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;
const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const VALID_QUEUE_CODE_REGEX = /^Q-[0-9]{3,6}$/;

type AppPage = 'kiosk' | 'staff' | 'tv';

function getPageFromUrl(): AppPage {
  if (typeof window === 'undefined') return 'kiosk';
  const hash = window.location.hash.toLowerCase();
  const pathname = window.location.pathname.toLowerCase();
  const searchParams = new URLSearchParams(window.location.search);
  const pageParam = (searchParams.get('page') || '').toLowerCase();

  if (
    hash.includes('staff') ||
    pathname.endsWith('/staff') ||
    pathname.includes('/staff/') ||
    pageParam === 'staff'
  ) {
    return 'staff';
  }
  if (
    hash.includes('tv') ||
    pathname.endsWith('/tv') ||
    pathname.includes('/tv/') ||
    pageParam === 'tv'
  ) {
    return 'tv';
  }
  return 'kiosk';
}

function formatCurrentTime(): string {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sanitizeId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  return VALID_ID_REGEX.test(cleaned) ? cleaned : `id-${Date.now()}`;
}

function formatQueueCodeForSpeech(queueCode: string): string {
  const parts = queueCode.split('-');
  if (parts.length === 2) {
    return `${parts[0]} ${parts[1].split('').join(' ')}`;
  }
  return queueCode;
}

function speakQueueAnnouncement(
  enabled: boolean,
  customer: QueueCustomer,
  isRecall: boolean
) {
  if (
    !enabled ||
    typeof window === 'undefined' ||
    !('speechSynthesis' in window)
  ) {
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const spokenCode = formatQueueCodeForSpeech(customer.queueCode);
    const priorityNote =
      customer.isPriority &&
      customer.priorityCategory &&
      customer.priorityCategory !== 'Regular'
        ? `, Priority ${customer.priorityCategory} lane,`
        : '';

    const message = isRecall
      ? `Recalling ticket ${spokenCode}, ${customer.name}${priorityNote}. Please proceed to the service counter.`
      : `Now serving ticket ${spokenCode}, ${customer.name}${priorityNote}, at the service counter.`;

    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 0.96;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore speech synthesis errors on unsupported browsers
  }
}

function playCallChime(enabled: boolean) {
  if (!enabled || typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

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
  // Active Separated Page State ('kiosk' = Public Customer Kiosk, 'staff' = Authorized Staff Console, 'tv' = Public TV Display)
  // Accessed exclusively via URL (/kiosk, /staff, /tv or #/kiosk, #/staff, #/tv)
  const [activePage, setActivePage] = useState<AppPage>(getPageFromUrl);

  useEffect(() => {
    const handleUrlChange = () => {
      setActivePage(getPageFromUrl());
    };
    window.addEventListener('hashchange', handleUrlChange);
    window.addEventListener('popstate', handleUrlChange);
    return () => {
      window.removeEventListener('hashchange', handleUrlChange);
      window.removeEventListener('popstate', handleUrlChange);
    };
  }, []);

  // Firebase Auth & Staff Role State
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isStaffVerified, setIsStaffVerified] = useState<boolean>(false);
  const [isAuthReady, setIsAuthReady] = useState<boolean>(false);
  const [isSigningIn, setIsSigningIn] = useState<boolean>(false);
  const [isJoiningQueue, setIsJoiningQueue] = useState<boolean>(false);
  const hasSeededSharedQueueRef = useRef<boolean>(false);

  // Shared Facility Queue State (Live synced from Cloud Firestore for both Public Kiosk & Staff)
  const [customers, setCustomers] = useState<QueueCustomer[]>(INITIAL_CUSTOMERS);
  const [nextSequence, setNextSequence] = useState<number>(108);
  const [activityLog, setActivityLog] = useState<QueueActivityEntry[]>(
    INITIAL_ACTIVITY_LOG
  );
  const [isCloudConnected, setIsCloudConnected] = useState<boolean>(false);

  // Customer Check-In Form State (Public Kiosk Page — No Login Required)
  const [customerName, setCustomerName] = useState('');
  const [customerPurpose, setCustomerPurpose] = useState(SERVICE_PURPOSES[0]);
  const [customerPriorityCategory, setCustomerPriorityCategory] =
    useState<PriorityCategory>('Regular');
  const [formError, setFormError] = useState<string | null>(null);
  const [lastIssuedTicket, setLastIssuedTicket] =
    useState<IssuedTicketReceipt | null>(null);

  // Audio/Voice Announcements & Flash State
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(true);
  const [isFlashingNowServing, setIsFlashingNowServing] =
    useState<boolean>(false);
  const [liveClock, setLiveClock] = useState<string>(() => formatCurrentTime());

  const prevServingSignatureRef = useRef<string | null>(null);

  // Staff Controls & UI Feedback State
  const [showStaffAuthBanner, setShowStaffAuthBanner] = useState<boolean>(false);
  const [staffBannerMessage, setStaffBannerMessage] = useState<{
    type: 'info' | 'warning' | 'success';
    text: string;
  } | null>(null);

  // Staff Console Filtering & Search State
  const [statusFilter, setStatusFilter] = useState<'ALL' | QueueStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Live clock for TV Display Mode
  useEffect(() => {
    const timer = setInterval(() => {
      setLiveClock(formatCurrentTime());
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // 1. Track Firebase Authentication & Verify / Register Staff Admin Record (/admins/{uid})
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        setIsStaffVerified(false);
        setIsAuthReady(true);
        return;
      }

      try {
        if (user.emailVerified && user.email === BOOTSTRAPPED_ADMIN_EMAIL) {
          setIsStaffVerified(true);
          setShowStaffAuthBanner(false);
        } else if (user.emailVerified) {
          const adminRef = doc(db, 'admins', user.uid);
          const adminSnap = await getDoc(adminRef);
          if (!adminSnap.exists()) {
            await setDoc(adminRef, {
              uid: user.uid,
              createdAt: serverTimestamp(),
            });
          }
          setIsStaffVerified(true);
          setShowStaffAuthBanner(false);
        } else {
          setIsStaffVerified(false);
        }
      } catch (error) {
        console.error('Error verifying staff role:', error);
        setIsStaffVerified(Boolean(user.emailVerified));
      } finally {
        setIsAuthReady(true);
      }
    });
    return () => unsubscribe();
  }, []);

  // 2. Attach Real-Time Shared Facility Listeners
  useEffect(() => {
    const counterRef = doc(db, 'queue_counters', SHARED_FACILITY_ID);
    const customersQuery = query(
      collection(db, 'queue_customers'),
      where('facilityId', '==', SHARED_FACILITY_ID)
    );
    const activitiesQuery = query(
      collection(db, 'queue_activities'),
      where('facilityId', '==', SHARED_FACILITY_ID)
    );

    const unsubCounter = onSnapshot(
      counterRef,
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const lastSeq = Number(data.lastSequenceNumber);
          if (!Number.isNaN(lastSeq) && lastSeq >= 100) {
            setNextSequence(lastSeq + 1);
          }
        }
      },
      (error) => {
        handleFirestoreError(
          error,
          OperationType.GET,
          `queue_counters/${SHARED_FACILITY_ID}`
        );
      }
    );

    const unsubCustomers = onSnapshot(
      customersQuery,
      async (snapshot) => {
        setIsCloudConnected(true);

        if (
          snapshot.empty &&
          !hasSeededSharedQueueRef.current &&
          localStorage.getItem('queueline_shared_cleared') !== 'true'
        ) {
          hasSeededSharedQueueRef.current = true;
          try {
            const batch = writeBatch(db);
            const ticketsToSeed = isStaffVerified
              ? INITIAL_CUSTOMERS
              : INITIAL_CUSTOMERS.filter(
                  (c) => c.status === QueueStatus.Waiting
                );

            ticketsToSeed.forEach((cust) => {
              const docId = sanitizeId(`shared_${cust.id}`);
              const ref = doc(db, 'queue_customers', docId);
              const payload: Record<string, unknown> = {
                id: docId,
                facilityId: SHARED_FACILITY_ID,
                sequenceNumber: cust.sequenceNumber,
                queueCode: cust.queueCode,
                name: cust.name.slice(0, MAX_NAME_LENGTH),
                purpose: cust.purpose.slice(0, MAX_PURPOSE_LENGTH),
                status: cust.status,
                joinedAt: cust.joinedAt.slice(0, 32),
                isPriority: Boolean(cust.isPriority),
                priorityCategory: cust.priorityCategory || 'Regular',
                recallCount: cust.recallCount || 0,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              };
              if (isStaffVerified && cust.calledAt) {
                payload.calledAt = cust.calledAt.slice(0, 32);
              }
              if (isStaffVerified && cust.completedAt) {
                payload.completedAt = cust.completedAt.slice(0, 32);
              }
              if (isStaffVerified && cust.lastRecalledAt) {
                payload.lastRecalledAt = cust.lastRecalledAt.slice(0, 32);
              }
              batch.set(ref, payload);
            });

            batch.set(doc(db, 'queue_counters', SHARED_FACILITY_ID), {
              id: SHARED_FACILITY_ID,
              facilityId: SHARED_FACILITY_ID,
              lastSequenceNumber: 107,
              updatedAt: serverTimestamp(),
            });

            INITIAL_ACTIVITY_LOG.forEach((act) => {
              const actDocId = sanitizeId(`shared_${act.id}`);
              batch.set(doc(db, 'queue_activities', actDocId), {
                id: actDocId,
                facilityId: SHARED_FACILITY_ID,
                timestamp: act.timestamp.slice(0, 32),
                queueCode: act.queueCode,
                customerName: act.customerName.slice(0, MAX_NAME_LENGTH),
                description: act.description.slice(0, MAX_DESCRIPTION_LENGTH),
                createdAt: serverTimestamp(),
              });
            });

            await batch.commit();
          } catch (error) {
            handleFirestoreError(error, OperationType.WRITE, 'queue_customers');
          }
          return;
        }

        const loaded: QueueCustomer[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            id: data.id,
            sequenceNumber: Number(data.sequenceNumber),
            queueCode: data.queueCode,
            name: data.name,
            purpose: data.purpose,
            status: data.status as QueueStatus,
            joinedAt: data.joinedAt,
            calledAt: data.calledAt,
            completedAt: data.completedAt,
            isPriority: Boolean(data.isPriority),
            priorityCategory:
              (data.priorityCategory as PriorityCategory) || 'Regular',
            recallCount: Number(data.recallCount) || 0,
            lastRecalledAt: data.lastRecalledAt,
          };
        });

        setCustomers(loaded);
        if (loaded.length > 0) {
          const maxSeq = Math.max(...loaded.map((c) => c.sequenceNumber));
          setNextSequence((prev) => Math.max(prev, maxSeq + 1));
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'queue_customers');
      }
    );

    const unsubActivities = onSnapshot(
      activitiesQuery,
      (snapshot) => {
        const loadedActs: QueueActivityEntry[] = snapshot.docs
          .map((d) => {
            const data = d.data();
            const createdMillis =
              data.createdAt && typeof data.createdAt.toMillis === 'function'
                ? data.createdAt.toMillis()
                : 0;
            return {
              id: data.id,
              timestamp: data.timestamp,
              queueCode: data.queueCode,
              customerName: data.customerName,
              description: data.description,
              _sortTime: createdMillis,
            };
          })
          .sort((a, b) => b._sortTime - a._sortTime)
          .map(({ _sortTime, ...rest }) => rest);

        setActivityLog(loadedActs);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'queue_activities');
      }
    );

    return () => {
      unsubCounter();
      unsubCustomers();
      unsubActivities();
    };
  }, [isStaffVerified]);

  // Derived Queue Segments
  const sortedCustomers = useMemo(() => {
    return [...customers].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }, [customers]);

  const currentlyServing = useMemo(() => {
    return sortedCustomers.find((c) => c.status === QueueStatus.Serving) || null;
  }, [sortedCustomers]);

  const waitingCustomers = useMemo(() => {
    return sortedCustomers
      .filter((c) => c.status === QueueStatus.Waiting)
      .sort((a, b) => {
        const aPrio = a.isPriority ? 1 : 0;
        const bPrio = b.isPriority ? 1 : 0;
        if (aPrio !== bPrio) {
          return bPrio - aPrio;
        }
        return a.sequenceNumber - b.sequenceNumber;
      });
  }, [sortedCustomers]);

  const nextWaitingCustomer = useMemo(() => {
    return waitingCustomers.length > 0 ? waitingCustomers[0] : null;
  }, [waitingCustomers]);

  const counts = useMemo(() => {
    return {
      total: sortedCustomers.length,
      waiting: waitingCustomers.length,
      priorityWaiting: waitingCustomers.filter((c) => c.isPriority).length,
      serving: sortedCustomers.filter((c) => c.status === QueueStatus.Serving)
        .length,
      served: sortedCustomers.filter((c) => c.status === QueueStatus.Served)
        .length,
      skipped: sortedCustomers.filter((c) => c.status === QueueStatus.Skipped)
        .length,
    };
  }, [sortedCustomers, waitingCustomers]);

  // Trigger visual flash highlight whenever the active Serving ticket or its recallCount changes
  useEffect(() => {
    if (!currentlyServing) {
      prevServingSignatureRef.current = null;
      return;
    }
    const sig = `${currentlyServing.id}:${currentlyServing.recallCount || 0}`;
    if (
      prevServingSignatureRef.current !== null &&
      prevServingSignatureRef.current !== sig
    ) {
      setIsFlashingNowServing(true);
      const timer = setTimeout(() => setIsFlashingNowServing(false), 2600);
      prevServingSignatureRef.current = sig;
      return () => clearTimeout(timer);
    }
    prevServingSignatureRef.current = sig;
  }, [currentlyServing]);

  const filteredStaffCustomers = useMemo(() => {
    return sortedCustomers.filter((customer) => {
      const matchesStatus =
        statusFilter === 'ALL' ? true : customer.status === statusFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        customer.name.toLowerCase().includes(q) ||
        customer.queueCode.toLowerCase().includes(q) ||
        customer.purpose.toLowerCase().includes(q) ||
        (customer.priorityCategory &&
          customer.priorityCategory.toLowerCase().includes(q));
      return matchesStatus && matchesSearch;
    });
  }, [sortedCustomers, statusFilter, searchQuery]);

  const handleGoogleStaffSignIn = async () => {
    setIsSigningIn(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user.emailVerified) {
        const adminRef = doc(db, 'admins', result.user.uid);
        const adminSnap = await getDoc(adminRef);
        if (!adminSnap.exists()) {
          await setDoc(adminRef, {
            uid: result.user.uid,
            createdAt: serverTimestamp(),
          });
        }
      }
      setIsStaffVerified(true);
      setShowStaffAuthBanner(false);
      setStaffBannerMessage({
        type: 'success',
        text: `Authorized Staff signed in (${result.user.email}). You can now call, recall, and manage tickets on the shared queue.`,
      });
    } catch (error) {
      setStaffBannerMessage({
        type: 'warning',
        text:
          error instanceof Error
            ? `Staff Google Sign-In failed: ${error.message}`
            : 'Staff Google Sign-In was cancelled or failed.',
      });
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleStaffSignOut = async () => {
    try {
      await signOut(auth);
      setIsStaffVerified(false);
      setStaffBannerMessage({
        type: 'info',
        text: 'Signed out of Staff Console.',
      });
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  const logSharedActivity = async (
    queueCode: string,
    name: string,
    description: string
  ) => {
    const docId = sanitizeId(
      `shared_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );
    const timeStr = formatCurrentTime();
    const safeName = name.trim().slice(0, MAX_NAME_LENGTH);
    const safeDesc = description.trim().slice(0, MAX_DESCRIPTION_LENGTH);

    try {
      await setDoc(doc(db, 'queue_activities', docId), {
        id: docId,
        facilityId: SHARED_FACILITY_ID,
        timestamp: timeStr.slice(0, 32),
        queueCode,
        customerName: safeName,
        description: safeDesc,
        createdAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.CREATE,
        `queue_activities/${docId}`
      );
    }
  };

  // Requirement 1 & 2 + Priority Lane Flag: Public Kiosk Customer Check-In
  const handleJoinQueue = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = customerName.trim().slice(0, MAX_NAME_LENGTH);
    if (!trimmedName) {
      setFormError('Please enter your name to receive a queue number.');
      return;
    }
    if (trimmedName.length < 2) {
      setFormError('Customer name must be at least 2 characters.');
      return;
    }

    setIsJoiningQueue(true);
    setFormError(null);

    const timeStr = formatCurrentTime();
    const isPrio = customerPriorityCategory !== 'Regular';
    const waitingAheadCount = isPrio
      ? waitingCustomers.filter((c) => c.isPriority).length
      : waitingCustomers.length;
    const safePurpose = customerPurpose.slice(0, MAX_PURPOSE_LENGTH);

    try {
      localStorage.removeItem('queueline_shared_cleared');
      const counterRef = doc(db, 'queue_counters', SHARED_FACILITY_ID);

      const issuedResult = await runTransaction(db, async (transaction) => {
        const counterSnap = await transaction.get(counterRef);
        let assignedSeq = 101;

        if (!counterSnap.exists()) {
          const highestExisting =
            sortedCustomers.length > 0
              ? Math.max(...sortedCustomers.map((c) => c.sequenceNumber))
              : 100;
          assignedSeq = Math.max(101, highestExisting + 1);
          transaction.set(counterRef, {
            id: SHARED_FACILITY_ID,
            facilityId: SHARED_FACILITY_ID,
            lastSequenceNumber: assignedSeq,
            updatedAt: serverTimestamp(),
          });
        } else {
          const currentLast =
            Number(counterSnap.data().lastSequenceNumber) || 100;
          assignedSeq = currentLast + 1;
          transaction.update(counterRef, {
            lastSequenceNumber: assignedSeq,
            updatedAt: serverTimestamp(),
          });
        }

        const assignedCode = `Q-${String(assignedSeq).padStart(3, '0')}`;
        if (!VALID_QUEUE_CODE_REGEX.test(assignedCode)) {
          throw new Error('Generated queue code failed format check.');
        }

        const docId = sanitizeId(`shared_cust_${assignedSeq}_${Date.now()}`);
        const customerRef = doc(db, 'queue_customers', docId);

        transaction.set(customerRef, {
          id: docId,
          facilityId: SHARED_FACILITY_ID,
          sequenceNumber: assignedSeq,
          queueCode: assignedCode,
          name: trimmedName,
          purpose: safePurpose,
          status: QueueStatus.Waiting,
          joinedAt: timeStr.slice(0, 32),
          isPriority: isPrio,
          priorityCategory: customerPriorityCategory,
          recallCount: 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        return { assignedCode, assignedSeq };
      });

      setCustomerName('');
      setCustomerPriorityCategory('Regular');
      setLastIssuedTicket({
        queueCode: issuedResult.assignedCode,
        name: trimmedName,
        purpose: safePurpose,
        joinedAt: timeStr,
        waitingAhead: waitingAheadCount,
        isPriority: isPrio,
        priorityCategory: customerPriorityCategory,
      });

      await logSharedActivity(
        issuedResult.assignedCode,
        trimmedName,
        isPrio
          ? `Joined Priority Lane (${customerPriorityCategory} · ${safePurpose})`
          : `Joined Regular Queue (${safePurpose})`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'queue_customers');
    } finally {
      setIsJoiningQueue(false);
    }
  };

  // Printable & Downloadable Ticket Slip Handlers
  const handlePrintTicketSlip = () => {
    window.print();
  };

  const handleDownloadTicketSlip = (ticket: IssuedTicketReceipt) => {
    const lines = [
      '========================================',
      '        QUEUELINE SERVICE TICKET        ',
      '========================================',
      `QUEUE NUMBER : ${ticket.queueCode}`,
      `CUSTOMER     : ${ticket.name}`,
      `LANE TIER    : ${
        ticket.isPriority
          ? `PRIORITY (${ticket.priorityCategory})`
          : 'Regular Sequential Queue'
      }`,
      `SERVICE      : ${ticket.purpose}`,
      `CHECK-IN TIME: ${ticket.joinedAt}`,
      `AHEAD IN LINE: ${ticket.waitingAhead} customer(s)`,
      '----------------------------------------',
      'Please watch the Live Counter Display',
      'and listen for your queue number call.',
      '========================================',
    ].join('\n');

    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `QueueLine-Ticket-${ticket.queueCode}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Requirement 4, 6, 7: Call Next Waiting Customer (Staff Page)
  const handleCallNextCustomer = async () => {
    if (!currentUser || !isStaffVerified) {
      setShowStaffAuthBanner(true);
      setStaffBannerMessage({
        type: 'warning',
        text: 'Staff Google Sign-In is required to call customers or modify the shared queue.',
      });
      return;
    }

    const timeStr = formatCurrentTime();
    const nextCandidate = waitingCustomers[0];

    if (!nextCandidate) {
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

    try {
      const batch = writeBatch(db);
      if (previousServing) {
        batch.update(doc(db, 'queue_customers', previousServing.id), {
          status: QueueStatus.Served,
          completedAt: timeStr.slice(0, 32),
          updatedAt: serverTimestamp(),
        });
      }
      batch.update(doc(db, 'queue_customers', nextCandidate.id), {
        status: QueueStatus.Serving,
        calledAt: timeStr.slice(0, 32),
        recallCount: 0,
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `queue_customers/${nextCandidate.id}`
      );
    }

    playCallChime(soundEnabled);
    speakQueueAnnouncement(voiceEnabled, nextCandidate, false);
    setIsFlashingNowServing(true);
    setTimeout(() => setIsFlashingNowServing(false), 2600);

    if (previousServing) {
      await logSharedActivity(
        previousServing.queueCode,
        previousServing.name,
        'Completed service · Marked as Served'
      );
    }
    await logSharedActivity(
      nextCandidate.queueCode,
      nextCandidate.name,
      nextCandidate.isPriority
        ? `Called next from Priority Lane (${nextCandidate.priorityCategory}) · Serving`
        : 'Called as next active customer · Status set to Serving'
    );

    setStaffBannerMessage({
      type: 'success',
      text: previousServing
        ? `Completed ${previousServing.queueCode} (${previousServing.name}) and called next waiting customer: ${nextCandidate.queueCode} — ${nextCandidate.name}.`
        : `Now serving ${nextCandidate.queueCode} — ${nextCandidate.name}.`,
    });
  };

  // Recall / Re-Announce Active Customer at Counter
  const handleRecallActiveCustomer = async () => {
    if (!currentlyServing) return;

    if (!currentUser || !isStaffVerified) {
      setShowStaffAuthBanner(true);
      setStaffBannerMessage({
        type: 'warning',
        text: 'Sign in with a Staff Google Account to recall the active customer.',
      });
      return;
    }

    const timeStr = formatCurrentTime();
    const nextRecallCount = (currentlyServing.recallCount || 0) + 1;

    try {
      await updateDoc(doc(db, 'queue_customers', currentlyServing.id), {
        recallCount: nextRecallCount,
        lastRecalledAt: timeStr.slice(0, 32),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `queue_customers/${currentlyServing.id}`
      );
    }

    playCallChime(soundEnabled);
    speakQueueAnnouncement(voiceEnabled, currentlyServing, true);
    setIsFlashingNowServing(true);
    setTimeout(() => setIsFlashingNowServing(false), 2600);

    await logSharedActivity(
      currentlyServing.queueCode,
      currentlyServing.name,
      `Recalled at counter (Recall #${nextRecallCount})`
    );

    setStaffBannerMessage({
      type: 'info',
      text: `Recalled ${currentlyServing.queueCode} (${currentlyServing.name}) — Chime & voice announcement replayed (Recall #${nextRecallCount}).`,
    });
  };

  // Toggle Priority Lane status for a customer from Staff Console
  const handleToggleCustomerPriority = async (customer: QueueCustomer) => {
    if (!currentUser || !isStaffVerified) {
      setShowStaffAuthBanner(true);
      setStaffBannerMessage({
        type: 'warning',
        text: 'Sign in with a Staff Google Account to change priority lane assignments.',
      });
      return;
    }

    if (customer.status === QueueStatus.Served) {
      setStaffBannerMessage({
        type: 'warning',
        text: `Ticket ${customer.queueCode} (${customer.name}) has already been Served and can no longer be edited or changed.`,
      });
      return;
    }

    const nextIsPriority = !customer.isPriority;
    const nextCategory: PriorityCategory = nextIsPriority
      ? 'Senior Citizen'
      : 'Regular';

    try {
      await updateDoc(doc(db, 'queue_customers', customer.id), {
        isPriority: nextIsPriority,
        priorityCategory: nextCategory,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `queue_customers/${customer.id}`
      );
    }

    await logSharedActivity(
      customer.queueCode,
      customer.name,
      nextIsPriority
        ? `Assigned to Priority Lane (${nextCategory})`
        : 'Moved to Regular Queue tier'
    );
  };

  // Requirement 5 & 7: Allow Authorized Staff to mark customers as Waiting, Serving, Served, Skipped
  const handleUpdateCustomerStatus = async (
    targetCustomer: QueueCustomer,
    newStatus: QueueStatus
  ) => {
    if (!currentUser || !isStaffVerified) {
      setShowStaffAuthBanner(true);
      setStaffBannerMessage({
        type: 'warning',
        text: 'Sign in with a Staff Google Account to change customer queue statuses.',
      });
      return;
    }

    if (targetCustomer.status === QueueStatus.Served) {
      setStaffBannerMessage({
        type: 'warning',
        text: `Ticket ${targetCustomer.queueCode} (${targetCustomer.name}) has already been Served and can no longer be edited or changed.`,
      });
      return;
    }

    if (targetCustomer.status === newStatus) return;

    if (
      newStatus === QueueStatus.Serving &&
      targetCustomer.status === QueueStatus.Skipped
    ) {
      setStaffBannerMessage({
        type: 'warning',
        text: `Cannot call ${targetCustomer.queueCode} (${targetCustomer.name}) directly because their status is Skipped. Mark as Waiting first if you need to re-queue them.`,
      });
      return;
    }

    const timeStr = formatCurrentTime();

    try {
      const batch = writeBatch(db);
      if (
        newStatus === QueueStatus.Serving &&
        currentlyServing &&
        currentlyServing.id !== targetCustomer.id
      ) {
        batch.update(doc(db, 'queue_customers', currentlyServing.id), {
          status: QueueStatus.Served,
          completedAt: timeStr.slice(0, 32),
          updatedAt: serverTimestamp(),
        });
      }

      const targetRef = doc(db, 'queue_customers', targetCustomer.id);
      if (newStatus === QueueStatus.Serving) {
        batch.update(targetRef, {
          status: QueueStatus.Serving,
          calledAt: timeStr.slice(0, 32),
          recallCount: 0,
          updatedAt: serverTimestamp(),
        });
      } else if (
        newStatus === QueueStatus.Served ||
        newStatus === QueueStatus.Skipped
      ) {
        batch.update(targetRef, {
          status: newStatus,
          completedAt: timeStr.slice(0, 32),
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.update(targetRef, {
          status: QueueStatus.Waiting,
          completedAt: deleteField(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.UPDATE,
        `queue_customers/${targetCustomer.id}`
      );
    }

    if (newStatus === QueueStatus.Serving) {
      playCallChime(soundEnabled);
      speakQueueAnnouncement(voiceEnabled, targetCustomer, false);
      setIsFlashingNowServing(true);
      setTimeout(() => setIsFlashingNowServing(false), 2600);
    }

    await logSharedActivity(
      targetCustomer.queueCode,
      targetCustomer.name,
      `Status changed from ${targetCustomer.status} to ${newStatus}`
    );

    setStaffBannerMessage({
      type: 'info',
      text: `Updated ${targetCustomer.queueCode} (${targetCustomer.name}) status to ${newStatus}.`,
    });
  };

  const handleResetDemoData = async () => {
    if (!currentUser || !isStaffVerified) {
      setShowStaffAuthBanner(true);
      return;
    }

    localStorage.removeItem('queueline_shared_cleared');
    try {
      const batch = writeBatch(db);
      customers.forEach((c) => {
        batch.delete(doc(db, 'queue_customers', c.id));
      });
      activityLog.forEach((a) => {
        batch.delete(doc(db, 'queue_activities', a.id));
      });

      INITIAL_CUSTOMERS.forEach((cust) => {
        const docId = sanitizeId(`shared_${cust.id}`);
        const payload: Record<string, unknown> = {
          id: docId,
          facilityId: SHARED_FACILITY_ID,
          sequenceNumber: cust.sequenceNumber,
          queueCode: cust.queueCode,
          name: cust.name.slice(0, MAX_NAME_LENGTH),
          purpose: cust.purpose.slice(0, MAX_PURPOSE_LENGTH),
          status: cust.status,
          joinedAt: cust.joinedAt.slice(0, 32),
          isPriority: Boolean(cust.isPriority),
          priorityCategory: cust.priorityCategory || 'Regular',
          recallCount: cust.recallCount || 0,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (cust.calledAt) payload.calledAt = cust.calledAt.slice(0, 32);
        if (cust.completedAt)
          payload.completedAt = cust.completedAt.slice(0, 32);
        if (cust.lastRecalledAt)
          payload.lastRecalledAt = cust.lastRecalledAt.slice(0, 32);
        batch.set(doc(db, 'queue_customers', docId), payload);
      });

      batch.set(doc(db, 'queue_counters', SHARED_FACILITY_ID), {
        id: SHARED_FACILITY_ID,
        facilityId: SHARED_FACILITY_ID,
        lastSequenceNumber: 107,
        updatedAt: serverTimestamp(),
      });

      INITIAL_ACTIVITY_LOG.forEach((act) => {
        const actDocId = sanitizeId(`shared_${act.id}`);
        batch.set(doc(db, 'queue_activities', actDocId), {
          id: actDocId,
          facilityId: SHARED_FACILITY_ID,
          timestamp: act.timestamp.slice(0, 32),
          queueCode: act.queueCode,
          customerName: act.customerName.slice(0, MAX_NAME_LENGTH),
          description: act.description.slice(0, MAX_DESCRIPTION_LENGTH),
          createdAt: serverTimestamp(),
        });
      });

      await batch.commit();
      setLastIssuedTicket(null);
      setStaffBannerMessage({
        type: 'info',
        text: 'Shared facility queue restored to initial sample state (Q-101 through Q-107).',
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'queue_customers');
    }
  };

  const handleClearAllQueue = async () => {
    if (!currentUser || !isStaffVerified) {
      setShowStaffAuthBanner(true);
      return;
    }

    localStorage.setItem('queueline_shared_cleared', 'true');
    try {
      await Promise.all([
        ...customers.map((c) => deleteDoc(doc(db, 'queue_customers', c.id))),
        ...activityLog.map((a) => deleteDoc(doc(db, 'queue_activities', a.id))),
        setDoc(doc(db, 'queue_counters', SHARED_FACILITY_ID), {
          id: SHARED_FACILITY_ID,
          facilityId: SHARED_FACILITY_ID,
          lastSequenceNumber: 100,
          updatedAt: serverTimestamp(),
        }),
      ]);
      setLastIssuedTicket(null);
      setStaffBannerMessage({
        type: 'info',
        text: 'Shared facility queue cleared. Next customer check-in will be assigned Q-101.',
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'queue_customers');
    }
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

  // ============================================================================
  // PAGE 3: Dedicated Full-Screen TV / Monitor Public Display View ('tv')
  // ============================================================================
  if (activePage === 'tv') {
    const nextFiveWaiting = waitingCustomers.slice(0, 5);
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between p-6 sm:p-10 no-print">
        <header className="flex flex-wrap items-center justify-between gap-6 border-b border-slate-800 pb-5">
          <div>
            <div className="text-2xl font-bold tracking-tight text-white">
              QueueLine Public Monitor
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Main Service Counter · Priority &amp; Sequential Queue Display
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-lg font-mono font-semibold text-slate-200 tabular-nums pr-2">
              {liveClock}
            </span>

            <button
              type="button"
              onClick={() => setVoiceEnabled((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-slate-900 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Megaphone className="w-3.5 h-3.5 text-emerald-400" />
              <span>{voiceEnabled ? 'Voice On' : 'Voice Muted'}</span>
            </button>

            <button
              type="button"
              onClick={() => setSoundEnabled((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-200 bg-slate-900 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {soundEnabled ? (
                <>
                  <Volume2 className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Chime On</span>
                </>
              ) : (
                <>
                  <VolumeX className="w-3.5 h-3.5 text-slate-500" />
                  <span>Chime Muted</span>
                </>
              )}
            </button>
          </div>
        </header>

        <div className="my-8 grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch flex-1">
          {/* Now Serving Focal Box */}
          <div
            className={`lg:col-span-7 rounded-2xl border p-8 sm:p-12 flex flex-col justify-between transition-opacity duration-200 ${
              isFlashingNowServing
                ? 'bg-emerald-950/90 border-emerald-400'
                : 'bg-slate-900 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-semibold text-emerald-400 tracking-wide">
                Now Serving at Counter
              </span>
              <span className="text-sm font-mono text-slate-400 tabular-nums">
                {currentlyServing
                  ? `Called ${currentlyServing.calledAt || currentlyServing.joinedAt}`
                  : 'Standby'}
              </span>
            </div>

            {currentlyServing ? (
              <div className="my-auto py-8 space-y-4">
                <div className="text-7xl sm:text-8xl lg:text-9xl font-bold font-mono tracking-tight text-white tabular-nums">
                  {currentlyServing.queueCode}
                </div>
                <div className="text-3xl sm:text-4xl font-bold text-slate-100">
                  {currentlyServing.name}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-base text-slate-300 pt-2">
                  <span>{currentlyServing.purpose}</span>
                  {currentlyServing.isPriority &&
                    currentlyServing.priorityCategory && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1.5 font-semibold text-amber-300">
                          <HeartHandshake className="w-4 h-4" />
                          <span>
                            Priority Lane ({currentlyServing.priorityCategory})
                          </span>
                        </span>
                      </>
                    )}
                  {Boolean(currentlyServing.recallCount) && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-emerald-300 tabular-nums">
                        Recalled {currentlyServing.recallCount}x
                      </span>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="my-auto py-12 space-y-3">
                <div className="text-6xl sm:text-7xl font-bold font-mono text-slate-600 tabular-nums">
                  — — —
                </div>
                <p className="text-2xl font-semibold text-slate-300">
                  Counter Ready · Waiting for Next Call
                </p>
              </div>
            )}

            <div className="pt-6 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4 text-sm text-slate-400">
              <span>
                Please proceed to the counter when your queue number is
                announced.
              </span>
            </div>
          </div>

          {/* Right 5 Cols: Next 5 Waiting Customers */}
          <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-8 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-4 border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-xl font-bold text-white">
                    Up Next in Waiting Line
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Priority Lane customers are called ahead in arrival order
                  </p>
                </div>
                <span className="text-sm font-mono font-semibold text-amber-400 tabular-nums">
                  {counts.waiting} Waiting
                </span>
              </div>

              {nextFiveWaiting.length > 0 ? (
                <div className="divide-y divide-slate-800 mt-3">
                  {nextFiveWaiting.map((cust, index) => (
                    <div
                      key={cust.id}
                      className="py-4 flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-4 min-w-0">
                        <span className="text-sm font-mono font-semibold text-slate-500 tabular-nums w-7 shrink-0">
                          #{index + 1}
                        </span>
                        <span className="text-2xl sm:text-3xl font-bold font-mono text-white tabular-nums shrink-0">
                          {cust.queueCode}
                        </span>
                        <div className="min-w-0">
                          <div className="text-lg font-semibold text-slate-100 truncate">
                            {cust.name}
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-400">
                            <span className="truncate">{cust.purpose}</span>
                            {cust.isPriority && cust.priorityCategory && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="text-amber-300 font-semibold whitespace-nowrap">
                                  Priority ({cust.priorityCategory})
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {index === 0 && (
                        <span className="text-xs font-semibold text-amber-300 whitespace-nowrap shrink-0">
                          Next Up
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-16 text-center text-slate-500">
                  No customers currently waiting in line.
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400 tabular-nums">
              <span>Priority Waiting: {counts.priorityWaiting}</span>
              <span>Served Today: {counts.served}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      id="top"
      className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]"
    >
      {/* Printable Thermal Receipt Slip (Hidden on screen, visible only during @media print) */}
      {lastIssuedTicket && (
        <div id="printable-ticket-slip" className="hidden" aria-hidden="true">
          <div className="text-center space-y-2 font-mono">
            <div className="text-xs font-bold tracking-widest">
              QUEUELINE OFFICIAL TICKET
            </div>
            <div className="text-[11px]">Main Service Counter</div>
            <div className="border-t border-b border-black py-3 my-2">
              <div className="text-xs">ASSIGNED QUEUE NUMBER</div>
              <div className="text-4xl font-bold tabular-nums mt-1">
                {lastIssuedTicket.queueCode}
              </div>
              {lastIssuedTicket.isPriority && (
                <div className="text-xs font-bold mt-1">
                  PRIORITY LANE: {lastIssuedTicket.priorityCategory}
                </div>
              )}
            </div>
            <div className="text-left text-xs space-y-1">
              <div>Customer: {lastIssuedTicket.name}</div>
              <div>Category: {lastIssuedTicket.purpose}</div>
              <div>Issued At: {lastIssuedTicket.joinedAt}</div>
              <div>Ahead in Line: {lastIssuedTicket.waitingAhead}</div>
            </div>
            <div className="pt-3 text-[10px] border-t border-black mt-3">
              Please watch the Live Counter Display and listen for your number.
            </div>
          </div>
        </div>
      )}

      {/* Main Content Container (No Navbars — Pages Accessed Only via URL) */}
      <main
        className={`no-print flex-1 w-full max-w-[1360px] mx-auto px-6 lg:px-10 py-8 flex flex-col ${
          activePage === 'kiosk' ? 'justify-center' : 'justify-start'
        }`}
      >
        {/* ==================================================================== */}
        {/* PAGE 1: PUBLIC CUSTOMER KIOSK PAGE (Only Get Your Queue Ticket Form) */}
        {/* ==================================================================== */}
        {activePage === 'kiosk' && (
          <div className="w-full max-w-lg mx-auto">
            <div
              id="join-queue"
              className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-4">
                  <div>
                    <h1 className="text-xl font-bold text-slate-900">
                      Get Your Queue Ticket
                    </h1>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Enter your full name and select your service purpose to
                      join the line
                    </p>
                  </div>
                  <span className="text-xs font-mono font-semibold text-slate-700 tabular-nums">
                    Ticket Q-{String(nextSequence).padStart(3, '0')}
                  </span>
                </div>

                <form onSubmit={handleJoinQueue} className="mt-6 space-y-5">
                  <div>
                    <label
                      htmlFor="customer-name-input"
                      className="block text-xs font-semibold text-slate-800 mb-1.5"
                    >
                      Your Full Name <span className="text-rose-600">*</span>
                    </label>
                    <input
                      id="customer-name-input"
                      type="text"
                      maxLength={MAX_NAME_LENGTH}
                      value={customerName}
                      onChange={(e) => {
                        setCustomerName(e.target.value);
                        if (formError) setFormError(null);
                      }}
                      placeholder="e.g., Jordan Rivera"
                      className="w-full px-4 py-3 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 transition-colors"
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
                      className="w-full px-4 py-3 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 transition-colors"
                    >
                      {SERVICE_PURPOSES.map((purpose) => (
                        <option key={purpose} value={purpose}>
                          {purpose}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="customer-priority-select"
                      className="block text-xs font-semibold text-slate-800 mb-1.5"
                    >
                      Queue Lane / Priority Eligibility
                    </label>
                    <select
                      id="customer-priority-select"
                      value={customerPriorityCategory}
                      onChange={(e) =>
                        setCustomerPriorityCategory(
                          e.target.value as PriorityCategory
                        )
                      }
                      className="w-full px-4 py-3 text-sm bg-slate-50 border border-slate-300 rounded-lg text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-slate-900 transition-colors"
                    >
                      {PRIORITY_CATEGORIES.map((cat) => (
                        <option key={cat.id} value={cat.id}>
                          {cat.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="submit"
                    disabled={isJoiningQueue}
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 active:scale-[0.99] transition-all whitespace-nowrap cursor-pointer disabled:opacity-60"
                  >
                    <UserPlus className="w-4 h-4" />
                    <span>
                      {isJoiningQueue
                        ? 'Assigning Queue Number...'
                        : 'Join Queue & Get Ticket Number'}
                    </span>
                  </button>
                </form>
              </div>

              {/* Issued Ticket Confirmation & Print/Download Slip */}
              <div className="mt-6 pt-5 border-t border-slate-200">
                {lastIssuedTicket ? (
                  <div
                    className="space-y-3"
                    role="status"
                    aria-live="polite"
                    data-testid="issued-ticket-receipt"
                  >
                    <div className="flex items-center justify-between text-xs text-emerald-700 font-semibold">
                      <span>Your Queue Ticket Is Ready</span>
                      <span className="font-mono tabular-nums">
                        Issued {lastIssuedTicket.joinedAt}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <div>
                        <div className="text-xs text-slate-500">
                          Assigned Queue Number
                        </div>
                        <div className="text-3xl font-bold font-mono text-slate-900 tabular-nums">
                          {lastIssuedTicket.queueCode}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-base font-semibold text-slate-900">
                          {lastIssuedTicket.name}
                        </div>
                        <div className="text-xs text-slate-500">
                          {lastIssuedTicket.isPriority
                            ? `Priority (${lastIssuedTicket.priorityCategory})`
                            : 'Regular Queue'}{' '}
                          ·{' '}
                          <span className="font-mono tabular-nums">
                            {lastIssuedTicket.waitingAhead}
                          </span>{' '}
                          ahead of you
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-2">
                      <button
                        type="button"
                        onClick={handlePrintTicketSlip}
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <Printer className="w-3.5 h-3.5" />
                        <span>Print Ticket Slip</span>
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          handleDownloadTicketSlip(lastIssuedTicket)
                        }
                        className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Save Ticket (.txt)</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 space-y-1">
                    <p className="font-medium text-slate-700">
                      How Customer Check-In Works
                    </p>
                    <p>
                      1. Enter your name and click{' '}
                      <strong>Join Queue &amp; Get Ticket Number</strong>.
                    </p>
                    <p>
                      2. Print or save your assigned queue code and listen for
                      your number announcement at the service counter.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ==================================================================== */}
        {/* PAGE 2: AUTHORIZED STAFF CONSOLE PAGE (Staff Queue Management View)  */}
        {/* ==================================================================== */}
        {activePage === 'staff' && (
          <div className="space-y-8">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-slate-500">
                  Authorized Staff Workspace ·{' '}
                  {currentUser && isStaffVerified
                    ? `Signed in as ${currentUser.email}`
                    : 'Staff Google Sign-In Required for Mutations'}
                </p>
                <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-0.5">
                  Staff Counter Control &amp; Queue Management
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2 self-start lg:self-auto">

                <button
                  type="button"
                  onClick={() => setVoiceEnabled((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Megaphone
                    className={`w-3.5 h-3.5 ${
                      voiceEnabled ? 'text-emerald-600' : 'text-slate-400'
                    }`}
                  />
                  <span>{voiceEnabled ? 'Voice On' : 'Voice Muted'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSoundEnabled((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
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

                {isAuthReady && currentUser && isStaffVerified ? (
                  <button
                    type="button"
                    onClick={handleStaffSignOut}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Staff Authorized ({currentUser.email})</span>
                    <LogOut className="w-3 h-3 ml-1 text-emerald-700" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleGoogleStaffSignIn}
                    disabled={isSigningIn}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-900 bg-amber-50 border border-amber-300 rounded-lg hover:bg-amber-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <LogIn className="w-3.5 h-3.5 text-amber-700" />
                    <span>
                      {isSigningIn
                        ? 'Verifying Staff...'
                        : 'Staff Sign In with Google'}
                    </span>
                  </button>
                )}
              </div>
            </div>

            {/* Staff Sign-In Callout when not yet authenticated */}
            {(showStaffAuthBanner || !currentUser || !isStaffVerified) && (
              <div className="p-5 bg-white border border-amber-300 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Lock className="w-4 h-4 text-amber-600" />
                    <span>Staff Authentication Required for Counter Actions</span>
                  </div>
                  <p className="text-xs text-slate-600">
                    Sign in with your Google account to unlock calling the next
                    customer, recalling active tickets, and changing customer
                    statuses on the shared Cloud Firestore queue.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleGoogleStaffSignIn}
                    disabled={isSigningIn}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <LogIn className="w-3.5 h-3.5" />
                    <span>
                      {isSigningIn
                        ? 'Signing In...'
                        : 'Sign in with Google (Staff)'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {/* Staff Active Counter Control Board */}
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
              <div className="grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 items-stretch">
                {/* Left 7 Cols: Active Counter Terminal (Structured Full-Width Stacked Layout) */}
                <div
                  className={`lg:col-span-7 p-6 sm:p-8 flex flex-col justify-between text-white transition-colors duration-200 ${
                    isFlashingNowServing ? 'bg-emerald-950' : 'bg-slate-900'
                  }`}
                >
                  {/* Terminal Header Row */}
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                      Active Counter Terminal · Now Serving
                    </span>
                    <span className="text-xs font-mono text-slate-400 tabular-nums">
                      {currentlyServing
                        ? `Called at ${currentlyServing.calledAt || currentlyServing.joinedAt}`
                        : 'Counter Standby'}
                    </span>
                  </div>

                  {/* Active Customer Display & Action Controls */}
                  {currentlyServing ? (
                    <div className="my-6 space-y-6">
                      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-4">
                        <div className="space-y-1.5 min-w-0">
                          <div className="text-xs font-medium text-emerald-400">
                            Currently at Service Counter
                          </div>
                          <div
                            className="text-5xl sm:text-6xl font-bold font-mono tracking-tight text-white tabular-nums"
                            data-testid="now-serving-number"
                          >
                            {currentlyServing.queueCode}
                          </div>
                        </div>

                        <div className="sm:text-right min-w-0">
                          <div
                            className="text-xl sm:text-2xl font-bold text-slate-100 truncate"
                            data-testid="now-serving-name"
                          >
                            {currentlyServing.name}
                          </div>
                          <div className="flex flex-wrap sm:justify-end items-center gap-2 text-xs text-slate-300 mt-1.5">
                            <span>{currentlyServing.purpose}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              Joined {currentlyServing.joinedAt}
                            </span>
                            {currentlyServing.isPriority &&
                              currentlyServing.priorityCategory && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span className="inline-flex items-center gap-1 font-semibold text-amber-300">
                                    <HeartHandshake className="w-3.5 h-3.5" />
                                    <span>
                                      Priority (
                                      {currentlyServing.priorityCategory})
                                    </span>
                                  </span>
                                </>
                              )}
                            {Boolean(currentlyServing.recallCount) && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono text-emerald-300 tabular-nums">
                                  Recalled {currentlyServing.recallCount}x
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Dedicated 4-Button Counter Action Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateCustomerStatus(
                              currentlyServing,
                              QueueStatus.Served
                            )
                          }
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-slate-950 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                          <span>Mark Served</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleRecallActiveCustomer}
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-amber-200 bg-slate-800 border border-amber-500/40 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <BellRing className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span>Recall / Ring</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateCustomerStatus(
                              currentlyServing,
                              QueueStatus.Skipped
                            )
                          }
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-semibold text-white bg-slate-800 border border-slate-700 rounded-lg hover:bg-rose-950 hover:border-rose-700 transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <SkipForward className="w-3.5 h-3.5 shrink-0" />
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
                          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 text-xs font-medium text-slate-300 bg-slate-800/80 border border-slate-700 rounded-lg hover:bg-slate-800 hover:text-white transition-colors whitespace-nowrap cursor-pointer"
                        >
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                          <span>Return Waiting</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="my-8 space-y-2">
                      <div
                        className="text-4xl sm:text-5xl font-bold font-mono text-slate-500 tabular-nums"
                        data-testid="now-serving-number"
                      >
                        — — —
                      </div>
                      <p className="text-base font-semibold text-slate-200">
                        No customer is currently being served
                      </p>
                      <p className="text-xs text-slate-400">
                        {waitingCustomers.length > 0
                          ? `${waitingCustomers.length} customer(s) waiting in line. Click "Call Next (${waitingCustomers[0].queueCode})" below to begin serving.`
                          : 'The waiting line is currently empty.'}
                      </p>
                    </div>
                  )}

                  {/* Terminal Bottom Next-Up & Call Next Bar */}
                  <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="text-xs text-slate-300 min-w-0 truncate">
                      {nextWaitingCustomer ? (
                        <span>
                          Next in waiting line:{' '}
                          <strong className="font-mono text-white tabular-nums">
                            {nextWaitingCustomer.queueCode}
                          </strong>{' '}
                          ({nextWaitingCustomer.name}
                          {nextWaitingCustomer.isPriority &&
                          nextWaitingCustomer.priorityCategory
                            ? ` · Priority: ${nextWaitingCustomer.priorityCategory}`
                            : ''}
                          )
                        </span>
                      ) : (
                        <span>No additional customers waiting in queue</span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={handleCallNextCustomer}
                      disabled={waitingCustomers.length === 0}
                      className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                        waitingCustomers.length > 0
                          ? 'bg-white text-slate-900 hover:bg-slate-100 cursor-pointer'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {waitingCustomers.length > 0
                          ? `Call Next (${waitingCustomers[0].queueCode})`
                          : 'No Waiting Customers'}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Right 5 Cols: Staff Metrics */}
                <div className="lg:col-span-5 grid grid-cols-2 divide-x divide-y divide-slate-200 bg-white">
                  <div className="p-6 flex flex-col justify-between">
                    <span className="text-xs font-medium text-slate-500">
                      Currently Waiting
                    </span>
                    <div className="mt-3">
                      <div className="text-3xl font-bold font-mono text-amber-700 tabular-nums">
                        {counts.waiting}
                      </div>
                      <p className="text-xs text-slate-500 mt-1 tabular-nums">
                        {counts.priorityWaiting} Priority ·{' '}
                        {counts.waiting - counts.priorityWaiting} Regular
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
                      <div className="text-3xl font-bold font-mono text-slate-900 tabular-nums">
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
                      <div className="text-3xl font-bold font-mono text-rose-700 tabular-nums">
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

            {/* Staff Queue Management Table & Controls */}
            <section
              id="staff-console"
              className="bg-white border border-slate-200 rounded-xl p-6 sm:p-7 space-y-5"
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-5">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    All Queue Tickets &amp; Status Management
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    Mark customers as Waiting, Serving, Served, or Skipped.
                    Once a ticket is marked as Served, it is permanently locked
                    and can no longer be edited or changed.
                  </p>
                </div>

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
                    <span className="font-medium">
                      {staffBannerMessage.text}
                    </span>
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

                <div className="relative w-full md:w-72">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search queue #, name, or priority..."
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
                      <th className="py-3 px-4 whitespace-nowrap">
                        Customer Name
                      </th>
                      <th className="py-3 px-4 whitespace-nowrap">
                        Lane &amp; Category
                      </th>
                      <th className="py-3 px-4 whitespace-nowrap">Timestamps</th>
                      <th className="py-3 px-4 whitespace-nowrap">
                        Current Status
                      </th>
                      <th className="py-3 px-4 text-right whitespace-nowrap">
                        Staff Status &amp; Priority Controls
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {filteredStaffCustomers.length > 0 ? (
                      filteredStaffCustomers.map((customer) => {
                        const isServed = customer.status === QueueStatus.Served;
                        const isServedOrSkipped =
                          isServed || customer.status === QueueStatus.Skipped;

                        return (
                          <tr
                            key={customer.id}
                            className={`transition-colors ${
                              customer.status === QueueStatus.Serving
                                ? 'bg-emerald-50/40 hover:bg-emerald-50/70'
                                : isServed
                                ? 'bg-slate-50/60'
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
                              <span>{customer.purpose}</span>
                              <span aria-hidden="true"> · </span>
                              {customer.isPriority ? (
                                <span className="font-semibold text-rose-700">
                                  Priority (
                                  {customer.priorityCategory || 'Senior Citizen'})
                                </span>
                              ) : (
                                <span className="text-slate-500">Regular</span>
                              )}
                            </td>
                            <td className="py-3 px-4 text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
                              <span>In {customer.joinedAt}</span>
                              {customer.calledAt && (
                                <>
                                  <span aria-hidden="true"> · </span>
                                  <span>Called {customer.calledAt}</span>
                                </>
                              )}
                              {Boolean(customer.recallCount) && (
                                <>
                                  <span aria-hidden="true"> · </span>
                                  <span>Recalled {customer.recallCount}x</span>
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
                              {isServed ? (
                                <div
                                  className="inline-flex items-center justify-end gap-1.5 text-xs font-medium text-slate-400 select-none"
                                  title="This queue ticket has been Served and can no longer be edited or changed."
                                >
                                  <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                  <span>Served · Locked</span>
                                </div>
                              ) : (
                                <div className="inline-flex items-center justify-end gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleToggleCustomerPriority(customer)
                                    }
                                    className={`px-2 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                      customer.isPriority
                                        ? 'bg-rose-50 text-rose-800 border-rose-300 hover:bg-rose-100'
                                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                                    }`}
                                  >
                                    {customer.isPriority
                                      ? 'Priority ★'
                                      : 'Set Priority'}
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateCustomerStatus(
                                        customer,
                                        QueueStatus.Waiting
                                      )
                                    }
                                    disabled={
                                      customer.status === QueueStatus.Waiting
                                    }
                                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                                      customer.status === QueueStatus.Waiting
                                        ? 'bg-amber-600 text-white border-amber-600 font-semibold cursor-default'
                                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 cursor-pointer'
                                    }`}
                                  >
                                    Waiting
                                  </button>

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
                                        ? 'Skipped customers cannot be called directly as the active customer. Mark as Waiting first to re-queue.'
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

                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateCustomerStatus(
                                        customer,
                                        QueueStatus.Served
                                      )
                                    }
                                    className="px-2.5 py-1 text-xs font-medium rounded-md border bg-white text-slate-700 border-slate-200 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    Served
                                  </button>

                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateCustomerStatus(
                                        customer,
                                        QueueStatus.Skipped
                                      )
                                    }
                                    disabled={
                                      customer.status === QueueStatus.Skipped
                                    }
                                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                                      customer.status === QueueStatus.Skipped
                                        ? 'bg-rose-600 text-white border-rose-600 font-semibold cursor-default'
                                        : 'bg-white text-slate-700 border-slate-200 hover:bg-rose-50 hover:text-rose-800 hover:border-rose-300 cursor-pointer'
                                    }`}
                                  >
                                    Skipped
                                  </button>
                                </div>
                              )}
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
                              Customers can join the queue from the Public
                              Customer Kiosk page.
                            </span>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Recent Activity Log */}
              <div className="pt-2 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <div className="lg:col-span-7 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-800">
                    Recent Shared Counter Activity
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
                            <span
                              aria-hidden="true"
                              className="text-slate-400"
                            >
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
                  <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                    <Users className="w-3.5 h-3.5 text-slate-700" />
                    <span>URL-Only Page Routing</span>
                  </div>
                  <p>
                    • <strong>Customer Kiosk (`#/kiosk` or `/kiosk`)</strong>:
                    Dedicated Get Your Queue Ticket check-in form.
                  </p>
                  <p>
                    • <strong>Staff Console (`#/staff` or `/staff`)</strong>:
                    Authorized staff dashboard for calling, recalling, and
                    managing queue statuses.
                  </p>
                  <p>
                    • <strong>TV Monitor (`#/tv` or `/tv`)</strong>: Full-screen
                    public counter display.
                  </p>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
