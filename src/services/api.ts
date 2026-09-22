import { networkApi } from './transport';
import { IndexedReplicaStorage } from './replica-storage';
import { WorkspaceReplica } from './replica';
import { requestAccount, accountFeatureReason } from './account-prompt';
export { ApiError } from './transport';
export const replicaStorage = new IndexedReplicaStorage();
export const replica = new WorkspaceReplica(replicaStorage, networkApi);
export const api = replica.request;
// Guests keep working locally; account-only features ask before attempting.
export function needsAccount() {
  if (!replica.guest) return false;
  requestAccount({ mode: 'signup', reason: accountFeatureReason });
  return true;
}
