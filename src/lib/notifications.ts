import{NotificationType}from'@prisma/client';import{prisma}from'./prisma.js';import{notifyUser}from'../socket.js';import{sendMail}from'./services.js'

type NotificationRow={id:string;userId:string;title:string;description:string;type:NotificationType;read:boolean;createdAt:Date}

export async function sendNotification(input:{userId:string;type:NotificationType;title:string;description:string;idempotencyKey:string}){const existing=await prisma.notification.findUnique({where:{idempotencyKey:input.idempotencyKey}});if(existing)return existing;const preference=await prisma.notificationPreference.findUnique({where:{userId_type:{userId:input.userId,type:input.type}}}),user=await prisma.user.findUnique({where:{id:input.userId},select:{email:true}});let row:NotificationRow|null=null;if(preference?.inApp??true){const created=await prisma.$queryRaw<NotificationRow[]>`
  INSERT INTO "Notification" ("userId", title, description, type, read, "idempotencyKey", "createdAt")
  VALUES (${input.userId}, ${input.title}, ${input.description}, ${input.type}, false, ${input.idempotencyKey}, NOW())
  ON CONFLICT ("idempotencyKey") DO NOTHING
  RETURNING id, "userId", title, description, type, read, "createdAt"
`;row=created[0]??null}if(row)notifyUser(input.userId,'notification:new',row);if(preference?.email&&user&&!user.email.includes('@guest.tradeflow.local'))void sendMail(user.email,input.title,`<p>${input.description}</p>`);return row}
export async function notifyTenantRoles(input:{tenantId:string;roles:string[];type:NotificationType;title:string;description:string;key:string}){const users=await prisma.user.findMany({where:{tenantId:input.tenantId,role:{in:input.roles as never[]}},select:{id:true}});return Promise.all(users.map(user=>sendNotification({userId:user.id,type:input.type,title:input.title,description:input.description,idempotencyKey:`${input.key}:${user.id}`})))}
