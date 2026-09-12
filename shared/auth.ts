import { z } from 'zod';
export const signupPolicyResponse = z.object({ mode: z.enum(['open', 'invite', 'closed']) });
