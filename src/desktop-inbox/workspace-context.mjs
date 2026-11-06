import {fileURLToPath} from 'node:url';
import {canonicalWorkspace,sameWorkspace} from './contracts.mjs';

// The caller's session environment is conveyed by the Boss skill on clients
// without MCP roots. It is explicit model-mediated context, not a host attestation.
export async function resolveRequestWorkspace({requestedRoot,pinnedRoot=null,getWorkspaceRoots=null}={}){
 const started=performance.now();
 let roots=null;
 if(getWorkspaceRoots)roots=await getWorkspaceRoots();
 if(roots!==null&&roots!==undefined){
  if(!Array.isArray(roots)||!roots.length)throw Error('WORKSPACE_CONTEXT_REQUIRED: client supplied no workspace roots');
  const canonical=[...new Set(roots.map(root=>canonicalWorkspace(fileURLToPath(root.uri))))];
  if(requestedRoot){
   const requested=canonicalWorkspace(requestedRoot);
   if(!canonical.some(root=>sameWorkspace(root,requested)))throw Error('WORKSPACE_CONTEXT_MISMATCH: requested workspace is outside client roots');
   return {root:requested,source:'mcp_roots',host_attested:true,discovery_ms:performance.now()-started};
  }
  if(canonical.length!==1)throw Error('WORKSPACE_CONTEXT_AMBIGUOUS: specify one of the client workspace roots');
  return {root:canonical[0],source:'mcp_roots',host_attested:true,discovery_ms:performance.now()-started};
 }
 const root=requestedRoot??pinnedRoot;
 if(!root)throw Error('WORKSPACE_CONTEXT_REQUIRED: pass absolute workspace_root from the current Codex environment_context; this client did not advertise MCP roots');
 return {root:canonicalWorkspace(root),source:requestedRoot?'session_context_argument':'legacy_pinned',host_attested:false,discovery_ms:performance.now()-started};
}
