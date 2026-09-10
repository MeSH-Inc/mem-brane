import { networkApi } from './transport';
import { IndexedReplicaStorage } from './replica-storage';
import { WorkspaceReplica } from './replica';
export { ApiError } from './transport';
export const replicaStorage = new IndexedReplicaStorage();
export const replica = new WorkspaceReplica(replicaStorage, networkApi);
export const api = replica.request;
