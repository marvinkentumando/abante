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
  ArrowRight,
  ShieldCheck,
  Cloud,
  LogIn,
  LogOut,
  Users,
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
} from './types/queue';
import {
  INITIAL_CUSTOMERS,
  INITIAL_ACTIVITY_LOG,
  SERVICE_PURPOSES,
} from './data/initialQueue';

const SHARED_FACILITY_ID = 'main-counter';
const BOOTSTRAPPED_ADMIN_EMAIL = 'tumando.marvinken@dnsc.edu.ph';

// Blueprint validation constants (synced with firebase-blueprint.json & firestore.rules)
const MAX_NAME_LENGTH = 80;
const MAX_PURPOSE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;
const VALID_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const VALID_QUEUE_CODE_REGEX = /^Q-[0-9]{3,6}$/;

function formatCurrentTime(): string {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function sanitizeId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 128);
  return VALID_ID_REGEX.test(cleaned) ? cleaned : `id-${Date.now()}`;
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

  // Customer Check-In Form State (Public Kiosk — No Login Required)
  const [customerName, setCustomerName] = useState('');
  const [customerPurpose, setCustomerPurpose] = useState(SERVICE_PURPOSES[0]);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastIssuedTicket, setLastIssuedTicket] =
    useState<IssuedTicketReceipt | null>(null);

  // Staff Controls & UI Feedback State
  const [showStaffAuthBanner, setShowStaffAuthBanner] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [staffBannerMessage, setStaffBannerMessage] = useState<{
    type: 'info' | 'warning' | 'success';
    text: string;
  } | null>(null);

  // Staff Console Filtering & Search State
  const [statusFilter, setStatusFilter] = useState<'ALL' | QueueStatus>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

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
        if (
          user.emailVerified &&
          user.email === BOOTSTRAPPED_ADMIN_EMAIL
        ) {
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

  // 2. Attach Real-Time Shared Facility Listeners (Works for BOTH Unauthenticated Kiosk & Authenticated Staff)
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

        // Seed initial shared queue if empty on first facility startup
        if (
          snapshot.empty &&
          !hasSeededSharedQueueRef.current &&
          localStorage.getItem('queueline_shared_cleared') !== 'true'
        ) {
          hasSeededSharedQueueRef.current = true;
          try {
            const batch = writeBatch(db);
            // If staff is signed in, we can seed all statuses; if public kiosk boots first, seed the Waiting tickets
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
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              };
              if (isStaffVerified && cust.calledAt) {
                payload.calledAt = cust.calledAt.slice(0, 32);
              }
              if (isStaffVerified && cust.completedAt) {
                payload.completedAt = cust.completedAt.slice(0, 32);
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
        text: `Authorized Staff signed in (${result.user.email}). You can now call customers and update ticket statuses on the shared queue.`,
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
        text: 'Signed out of Staff Console. Terminal is now in Public Kiosk / Display mode.',
      });
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

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
      waiting: sortedCustomers.filter((c) => c.status === QueueStatus.Waiting)
        .length,
      serving: sortedCustomers.filter((c) => c.status === QueueStatus.Serving)
        .length,
      served: sortedCustomers.filter((c) => c.status === QueueStatus.Served)
        .length,
      skipped: sortedCustomers.filter((c) => c.status === QueueStatus.Skipped)
        .length,
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

  // Requirement 1 & 2: Public Kiosk Customer Check-In (No Staff Login Required!)
  // Uses a Firestore Transaction on /queue_counters/main-counter for atomic sequential numbering
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
    const waitingAheadCount = waitingCustomers.length;
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
          const currentLast = Number(counterSnap.data().lastSequenceNumber) || 100;
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
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        return { assignedCode, assignedSeq };
      });

      setCustomerName('');
      setLastIssuedTicket({
        queueCode: issuedResult.assignedCode,
        name: trimmedName,
        purpose: safePurpose,
        joinedAt: timeStr,
        waitingAhead: waitingAheadCount,
      });

      await logSharedActivity(
        issuedResult.assignedCode,
        trimmedName,
        `Joined waiting queue via Kiosk (${safePurpose})`
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'queue_customers');
    } finally {
      setIsJoiningQueue(false);
    }
  };

  // Requirement 4, 6, 7: Allow Authorized Staff (Google Sign-In + /admins verified) to call the next waiting customer
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
      'Called as next active customer · Status set to Serving'
    );

    setStaffBannerMessage({
      type: 'success',
      text: previousServing
        ? `Completed ${previousServing.queueCode} (${previousServing.name}) and called next waiting customer: ${nextCandidate.queueCode} — ${nextCandidate.name}.`
        : `Now serving ${nextCandidate.queueCode} — ${nextCandidate.name}.`,
    });
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
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        };
        if (cust.calledAt) payload.calledAt = cust.calledAt.slice(0, 32);
        if (cust.completedAt)
          payload.completedAt = cust.completedAt.slice(0, 32);
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

  return (
    <div
      id="top"
      className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]"
    >
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
                Shared Facility Cloud Queue ({SHARED_FACILITY_ID}) ·{' '}
                {isCloudConnected
                  ? 'Live Multi-Device Sync Active'
                  : 'Connecting to Cloud Firestore...'}{' '}
                ·{' '}
                {currentUser && isStaffVerified
                  ? `Authorized Staff (${currentUser.email})`
                  : 'Public Kiosk & Display Mode (No Sign-In Needed to Join)'}
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 mt-0.5">
                Live Counter Status &amp; Shared Queue Monitor
              </h1>
            </div>

            {/* Staff Google Auth & Audio Chime Controls */}
            <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
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

              {isAuthReady && currentUser && isStaffVerified ? (
                <button
                  type="button"
                  onClick={handleStaffSignOut}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Signed in as Authorized Staff via Google"
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

          {/* Staff Google Authentication Banner when unauthenticated user clicks a Staff control */}
          {showStaffAuthBanner && (!currentUser || !isStaffVerified) && (
            <div className="p-4 bg-white border border-amber-300 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                  <Lock className="w-4 h-4 text-amber-600" />
                  <span>Authorized Staff Sign-In Required</span>
                </div>
                <p className="text-xs text-slate-600">
                  Customers can view and join the shared queue freely without signing in. Calling the next customer or changing ticket statuses requires an authorized Staff Google account.
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
                <button
                  type="button"
                  onClick={() => setShowStaffAuthBanner(false)}
                  className="px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </div>
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
                        ? `${waitingCustomers.length} customer(s) waiting in line. Authorized staff can click "Call Next Customer" to serve ${waitingCustomers[0].queueCode}.`
                        : 'The waiting line is currently empty. New customers can check in below without signing in.'}
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
                      In shared sequential line
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

        {/* Section 2: Two-Column Split — Public Customer Kiosk (Left) & Shared Waiting List (Right) */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left 5 Columns: Public Customer Kiosk Check-In Form (No Sign-In Needed) */}
          <div
            id="join-queue"
            className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 sm:p-7 flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    Public Customer Kiosk Check-In
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Open to all visitors · No login required to join the shared queue
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
                    maxLength={MAX_NAME_LENGTH}
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
                  disabled={isJoiningQueue}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 active:scale-[0.99] transition-all whitespace-nowrap cursor-pointer disabled:opacity-60"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>
                    {isJoiningQueue
                      ? 'Assigning Ticket...'
                      : 'Join Shared Queue & Issue Number'}
                  </span>
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
                    <span>Shared Facility Ticket Issued</span>
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
                    Atomic Cloud Sequence Counter
                  </p>
                  <p>
                    Every check-in atomically increments the shared facility counter in Firestore so multiple kiosks never issue duplicate ticket numbers.
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
                    Shared live sequential waiting order · Synchronized across all displays and staff stations
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
                              <span className="truncate">
                                {customer.purpose}
                              </span>
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
                            title={`Call ${customer.queueCode} now (Staff only)`}
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
                    All issued queue numbers have been served or skipped. Use
                    the Public Customer Kiosk Check-In form to add the next
                    arriving customer.
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
                Only customers with <strong>Waiting</strong> status appear here
                and are eligible for next call.
              </span>
              <span className="font-mono tabular-nums">
                Total Shared Records: {counts.total}
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
                  ·{' '}
                  {currentUser && isStaffVerified
                    ? `Verified Staff (${currentUser.email})`
                    : 'Staff Sign-In Required for Mutations'}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Manage all shared queue tickets across Waiting, Serving, Served,
                and Skipped states. Already Served or Skipped customers are
                prevented from being called as the next active customer.
              </p>
            </div>

            {/* Staff Primary Actions */}
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {!currentUser || !isStaffVerified ? (
                <button
                  type="button"
                  onClick={handleGoogleStaffSignIn}
                  disabled={isSigningIn}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>
                    {isSigningIn
                      ? 'Signing In...'
                      : 'Sign in with Google to Manage Queue'}
                  </span>
                </button>
              ) : (
                <>
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
                </>
              )}
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
                  <th className="py-3 px-4 whitespace-nowrap">
                    Service Category
                  </th>
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
                          Use the Public Customer Kiosk Check-In form above to
                          issue the first queue ticket.
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Recent Activity Log & Access Model Summary */}
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
              <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                <Users className="w-3.5 h-3.5 text-slate-700" />
                <span>Shared Facility Access &amp; Security Model</span>
              </div>
              <p>
                1. <strong>Public Kiosk &amp; Live Display</strong>: Customers
                can view the shared queue and join in real time without signing
                in. Firestore rules enforce that kiosk check-ins only create{' '}
                <strong>Waiting</strong> tickets with atomic sequence numbers.
              </p>
              <p>
                2. <strong>Authorized Staff Console</strong>: Calling customers
                and changing statuses require Google Sign-In verified against the{' '}
                <code className="font-mono text-[11px]">/admins</code> collection.
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 bg-white px-6 lg:px-10 py-4 mt-8">
        <div className="max-w-[1360px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <span>QueueLine — Shared-Facility Digital Queue Management System</span>
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
