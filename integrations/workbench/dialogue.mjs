// A bounded, deterministic simulated user. This never calls a model or sees judge answers.
export function workbenchTurnMessage(turn, previousAnswer=''){
 return turn.branch&&String(previousAnswer).includes(turn.branch.contains)?turn.branch.message:turn.message;
}
export function workbenchDialogueMatches(input,turns){
 return Array.isArray(turns)&&turns.length===input.turns.length&&turns.every((t,i)=>t.question===workbenchTurnMessage(input.turns[i],turns[i-1]?.answer||''));
}
