"""Desk indicator reference firmware; install MicroPython on Pico first."""
from machine import Pin
from time import ticks_ms, ticks_diff, sleep_ms

red = Pin(14, Pin.OUT, value=0)
green = Pin(15, Pin.OUT, value=0)
button = Pin(16, Pin.IN, Pin.PULL_UP)
mode = 0
stable = raw = button.value()
since = ticks_ms()
while True:
    level = button.value()
    if level != raw:
        raw, since = level, ticks_ms()
    if stable != raw and ticks_diff(ticks_ms(), since) >= 35:
        stable = raw
        if stable == 0:
            mode = (mode + 1) % 3
            red.value(mode == 2)
            green.value(mode == 1)
    sleep_ms(4)
