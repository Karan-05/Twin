'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import MeetingRoom from '@/components/MeetingRoom'

export default function Home() {
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const key = localStorage.getItem('groq_api_key')
    if (!key) {
      router.push('/settings')
    } else {
      setReady(true)
    }
  }, [router])

  if (!ready) return null
  return <MeetingRoom />
}
