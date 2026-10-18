/** Bound serialized UTF-8, including JSON escaping. Never silently drop records. */
export function jsonBytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value)); }
export function previewText(text: string, maxBytes: number) {
  let used=0, result='';
  for(const point of text){const n=Buffer.byteLength(point);if(used+n>maxBytes)break;result+=point;used+=n;}
  return result;
}
export function boundedMessage(message: Record<string, any>, budget: number) {
  if(jsonBytes(message)<=budget)return message;
  const result:Record<string,any>={...message,body:previewText(message.body,Math.max(64,Math.floor(budget/8))),result:message.result?previewText(message.result,128):null,resultTruncated:Boolean(message.result&&Buffer.byteLength(message.result)>128),bodyTruncated:true,bodyBytes:Buffer.byteLength(message.body),metadata:{},metadataOmitted:jsonBytes(message.metadata??{})>2,
    bodyNextAction:{tool:'office_message',action:'get',messageId:message.id,offset:0}};
  while(jsonBytes(result)>budget&&result.body.length)result.body=previewText(result.body,Math.floor(Buffer.byteLength(result.body)/2));
  if(jsonBytes(result)>budget){result.senderName=previewText(result.senderName,64);result.recipientName=previewText(result.recipientName,64);}
  result.bodyTruncated=result.body!==message.body;
  return result;
}
