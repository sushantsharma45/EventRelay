import type { organization_role } from 'pg';

declare global {
  namespace Express {
    interface Request {
      authUser?: { id: string; email: string };
      organizationId?: string;
      organizationRole?: string;
    }
  }
}

export {};
