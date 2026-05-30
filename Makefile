.PHONY: install demo api test
install:
	cd backend && pip install -r requirements.txt
demo:
	cd backend && PYTHONPATH=. python3 run_demo.py
api:
	cd backend && PYTHONPATH=. uvicorn app:app --reload --port 8000
test:
	cd backend && PYTHONPATH=. python3 -m pytest -q
