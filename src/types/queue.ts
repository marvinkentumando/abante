export enum QueueStatus {
  Waiting = 'Waiting',
  Serving = 'Serving',
  Served = 'Served',
  Skipped = 'Skipped',
}

export type PriorityCategory =
  | 'Regular'
  | 'Senior Citizen'
  | 'PWD'
  | 'Pregnant'
  | 'Emergency';

export interface QueueCustomer {
  id: string;
  sequenceNumber: number;
  queueCode: string;
  name: string;
  purpose: string;
  status: QueueStatus;
  joinedAt: string;
  calledAt?: string;
  completedAt?: string;
  isPriority?: boolean;
  priorityCategory?: PriorityCategory;
  recallCount?: number;
  lastRecalledAt?: string;
}

export interface QueueActivityEntry {
  id: string;
  timestamp: string;
  queueCode: string;
  customerName: string;
  description: string;
}

export interface IssuedTicketReceipt {
  queueCode: string;
  name: string;
  purpose: string;
  joinedAt: string;
  waitingAhead: number;
  isPriority: boolean;
  priorityCategory: PriorityCategory;
}
