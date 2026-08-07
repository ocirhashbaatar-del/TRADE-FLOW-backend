export async function attachVercelDomain(domain: string) {
  const token=process.env.VERCEL_TOKEN,project=process.env.VERCEL_PROJECT_ID,team=process.env.VERCEL_TEAM_ID
  if(!token||!project)return{configured:false,attached:false}
  const response=await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/domains${team?`?teamId=${encodeURIComponent(team)}`:''}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({name:domain})})
  const body=await response.json().catch(()=>({}))
  if(!response.ok&&response.status!==409)throw Object.assign(new Error('Vercel domain attach амжилтгүй.'),{status:502,details:body})
  return{configured:true,attached:true,body}
}
