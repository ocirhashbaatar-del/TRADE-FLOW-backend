import{NotificationType}from'@prisma/client';import{Router}from'express';import{z}from'zod';import{prisma}from'../lib/prisma.js';import{authenticate}from'../middleware/auth.js'
const router=Router();router.use(authenticate)
router.get('/',async(req,res)=>{const q=z.object({since:z.coerce.date().optional()}).parse(req.query);res.json(await prisma.notification.findMany({where:{userId:req.user!.id,...(q.since?{createdAt:{gt:q.since}}:{})},orderBy:{createdAt:'desc'},take:100}))})
router.patch('/read-all',async(req,res)=>res.json(await prisma.notification.updateMany({where:{userId:req.user!.id,read:false},data:{read:true}})))
router.patch('/:id/read',async(req,res)=>res.json(await prisma.notification.updateMany({where:{id:req.params.id,userId:req.user!.id},data:{read:true}})))
router.get('/preferences',async(req,res)=>res.json(await prisma.notificationPreference.findMany({where:{userId:req.user!.id}})))
router.put('/preferences',async(req,res)=>{const input=z.object({type:z.nativeEnum(NotificationType),inApp:z.boolean(),email:z.boolean(),sms:z.boolean()}).parse(req.body);res.json(await prisma.notificationPreference.upsert({where:{userId_type:{userId:req.user!.id,type:input.type}},update:input,create:{userId:req.user!.id,...input}}))})
export default router
