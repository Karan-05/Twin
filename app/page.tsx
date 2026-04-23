'use client'
import { useEffect, useState } from 'react'
import MeetingRoom from '@/components/MeetingRoom'

export default function Home() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  return <MeetingRoom />
}
