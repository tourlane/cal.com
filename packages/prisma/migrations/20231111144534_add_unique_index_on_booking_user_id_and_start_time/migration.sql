create unique index Booking_userId_startTime_idx on "Booking" ("userId", "startTime") where "userId" is not null and status = 'accepted';
